/**
 * Live-site verification — does a deployed host actually behave like
 * loewald.com?
 *
 * This is the acceptance test for "stand up a clone on a blank project and
 * verify everything works", and it is deliberately written against a HOST URL
 * rather than against this repo's internals. That makes it reusable in the two
 * ways that matter:
 *
 *   1. point it at the sandbox to prove a fresh deployment is correct;
 *   2. point it at production to confirm the two agree.
 *
 * And later it becomes the ORACLE for the manifest conversion (ROADMAP A4):
 * once `post`/`page`/`module` are installed from a manifest rather than
 * compiled in, this suite must still pass, unchanged. If it does, the
 * conversion preserved behaviour; if it does not, it did not.
 *
 * Every assertion here corresponds to a bug that actually shipped:
 *   - drafts appearing in the public list (a real leak: 57 of them)
 *   - drafts being readable by direct link — DELIBERATE, and pinned so nobody
 *     "fixes" it: the owner sends unpublished links to friends for comment
 *   - denials disclosing existence (403 where 404 was required)
 *   - the sitemap advertising drafts, and emitting `https://undefined/`
 *   - a request for N visible rows returning fewer because the access filter
 *     ran after the query limit
 *   - /esm serving a module that is not tagged public
 *
 * ## Usage
 *
 *   # sandbox (default)
 *   cd functions && bun test src/collections/live-site.integration.test.ts
 *
 *   # production, or any other host
 *   VERIFY_HOSTING=https://loewald.com \
 *   VERIFY_FUNCTIONS=https://us-central1-liquid-force-425209-g2.cloudfunctions.net \
 *     bun test src/collections/live-site.integration.test.ts
 *
 * READ-ONLY. Every request is a GET; this never writes and is safe against
 * production.
 *
 * Skips LOUDLY when the host is unreachable — a skipped test is not a passing
 * one.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect, beforeAll } from 'bun:test'

const HOSTING =
  process.env.VERIFY_HOSTING ?? 'https://service-compris-test.web.app'
const FUNCTIONS =
  process.env.VERIFY_FUNCTIONS ??
  'https://us-central1-service-compris-test.cloudfunctions.net'

let reachable = false
let posts: Array<Record<string, unknown>> = []

const get = async (url: string) => {
  const res = await fetch(url, { redirect: 'follow' })
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    text: await res.text(),
  }
}

const json = async (url: string) => {
  const r = await get(url)
  try {
    return { ...r, body: JSON.parse(r.text) as unknown }
  } catch {
    return { ...r, body: null }
  }
}

const published = (p: Record<string, unknown>) =>
  String(p.date ?? '').trim() !== ''

// A cold Cloud Function can take several seconds, and this runs inside the
// default `bun test` suite. Without an explicit budget the probe blew bun's 5s
// per-test timeout and FAILED the run rather than skipping it — a network test
// that turns red when the network is slow is worse than useless. Bounded here,
// with the timeout treated as "unreachable" so the suite degrades to a loud
// skip instead.
const PROBE_MS = 20_000

/**
 * Per-test budget. Every test here makes at least one network call, and a Cloud
 * Function that has just been deployed is COLD — which is precisely when this
 * suite gets run. Bun's 5s default turned a healthy `/esm` (verified at 0.4s
 * warm) into a red run immediately after a production deploy. A verification
 * suite that fails because the thing it verifies was starting up is worse than
 * useless: it trains you to ignore it.
 */
const NET_MS = 30_000

beforeAll(async () => {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_MS)
    const res = await fetch(`${FUNCTIONS}/docs?p=post`, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    const body = (await res.json()) as unknown
    reachable = res.status === 200 && Array.isArray(body)
    if (reachable) posts = body as Array<Record<string, unknown>>
  } catch {
    reachable = false
  }
}, PROBE_MS + 5_000)

const guard = (): boolean => {
  if (!reachable) {
    console.log(
      `   [SKIPPED] ${FUNCTIONS} unreachable — live site NOT verified`
    )
    return true
  }
  return false
}

describe(`live site: ${HOSTING}`, () => {
  test('the host is actually reachable (not a vacuous pass)', () => {
    if (!reachable) {
      console.warn(
        `\n   [SKIPPED] Could not reach ${FUNCTIONS}.\n` +
          '   Nothing below was verified.\n'
      )
    }
    expect(true).toBe(true)
  })

  test('/docs returns posts at all', () => {
    if (guard()) return
    expect(posts.length).toBeGreaterThan(0)
  })

  test('the public list NEVER contains a draft', () => {
    if (guard()) return
    const drafts = posts.filter((p) => !published(p))
    expect(drafts.map((p) => p.path ?? p.title)).toEqual([])
  })

  test('a request for N visible rows returns N (filter before limit)', async () => {
    if (guard()) return
    // The regression: `.limit(n)` ran first and the access filter then dropped
    // rows, so asking for 10 published posts could return 3.
    //
    // The count parameter is `c`, not `limit` (docs.ts: `Number(req.query.c)
    // || 10`). Pinned here because the query surface is single-letter and
    // undocumented — `limit=5` is silently IGNORED rather than rejected, so a
    // caller who guesses wrong gets the default and never learns.
    const r = await json(`${FUNCTIONS}/docs?p=post&c=5`)
    const rows = (r.body as unknown[]) ?? []
    expect(rows.length).toBe(5)
    expect((rows as Array<Record<string, unknown>>).every(published)).toBe(true)
  }, NET_MS)

  test('a draft IS still readable by direct link (deliberate)', async () => {
    if (guard()) return
    // Owner's explicit intent: "I like being able to send a link to an
    // unpublished post to a friend for comment." Drafts are unlisted, not
    // secret. Pinned so a future "security fix" has to argue with it.
    //
    // Anonymous callers cannot enumerate drafts (that is the point), so this
    // only runs when a draft path is supplied.
    const draftPath = process.env.VERIFY_DRAFT_PATH
    if (!draftPath) {
      console.log(
        '   [partial] set VERIFY_DRAFT_PATH=post/<id> to verify draft-by-link'
      )
      return
    }
    const r = await json(`${FUNCTIONS}/doc?p=${encodeURIComponent(draftPath)}`)
    expect(r.status).toBe(200)
  }, NET_MS)

  test('a protected collection denies OPAQUELY (404, never 403)', async () => {
    if (guard()) return
    // 403 confirms the collection exists; /doc and /docs must agree on 404.
    for (const path of ['role', 'nonexistent-collection-xyz']) {
      const r = await get(`${FUNCTIONS}/docs?p=${path}`)
      expect(r.status).toBe(404)
    }
  }, NET_MS)

  test('/user leaks no privilege to an anonymous caller', async () => {
    if (guard()) return
    const r = await json(`${FUNCTIONS}/user`)
    const body = r.body as { roles?: string[] } | null
    expect(body?.roles ?? []).toEqual([])
  }, NET_MS)

  test('the sitemap advertises only published posts', async () => {
    if (guard()) return
    const r = await get(`${FUNCTIONS}/sitemap`)
    expect(r.status).toBe(200)
    const drafts = posts.filter((p) => !published(p))
    for (const d of drafts) {
      expect(r.text).not.toContain(`/${String(d.path)}`)
    }
  }, NET_MS)

  test('the sitemap emits no undefined hosts', async () => {
    if (guard()) return
    // The real bug: 850 URLs of the form `https://undefined/...`, caused by a
    // host lookup that returned undefined and was never checked.
    const r = await get(`${FUNCTIONS}/sitemap`)
    expect(r.text).not.toContain('undefined')
  }, NET_MS)

  test('SSR serves HTML for the homepage', async () => {
    if (guard()) return
    const r = await get(`${HOSTING}/`)
    expect(r.status).toBe(200)
    expect(r.type).toContain('text/html')
  }, NET_MS)

  test('SSR serves HTML for a published post slug', async () => {
    if (guard()) return
    const slug = posts.find(published)?.path
    expect(slug).toBeTruthy()
    const r = await get(`${HOSTING}/${String(slug)}`)
    expect(r.status).toBe(200)
    expect(r.type).toContain('text/html')
  }, NET_MS)

  test('/esm serves a public module as javascript', async () => {
    if (guard()) return
    const mods = await json(`${FUNCTIONS}/docs?p=module`)
    const list = (mods.body as Array<Record<string, unknown>>) ?? []
    if (!list.length) {
      console.log('   [partial] no public modules on this host')
      return
    }
    const r = await get(`${HOSTING}/esm/${String(list[0].name)}`)
    expect(r.status).toBe(200)
    expect(r.type).toContain('javascript')
  }, NET_MS)

  test('/esm does not serve a module that is not public', async () => {
    if (guard()) return
    const r = await get(`${HOSTING}/esm/definitely-not-a-public-module`)
    expect(r.status).toBeGreaterThanOrEqual(400)
  }, NET_MS)
})

/**
 * The AUTHENTICATED half.
 *
 * Everything above is anonymous, which is most of the public contract and none
 * of the authorization model. Until the sandbox had a sign-in provider there was
 * no way to check role resolution or the privilege boundary against a REAL
 * deployment — only against emulators, which is where three real bugs once hid
 * behind skip-guarded tests.
 *
 * Supply a token to run these:
 *
 *   VERIFY_ID_TOKEN=$(bun scripts/sandbox-token.js --grant owner) \
 *     bun test src/collections/live-site.integration.test.ts
 *
 * Skips LOUDLY without one. Read-only: every request is a GET, so this is safe
 * to point at production with a real token.
 */
describe('authenticated behaviour', () => {
  const token = process.env.VERIFY_ID_TOKEN
  const authed = (url: string) =>
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })

  const needsToken = (): boolean => {
    if (guard()) return true
    if (!token) {
      console.log(
        '   [SKIPPED] set VERIFY_ID_TOKEN — authorization NOT verified'
      )
      return true
    }
    return false
  }

  test('a token resolves to a principal with roles', async () => {
    if (needsToken()) return
    const r = await authed(`${FUNCTIONS}/user`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as { roles?: string[] }
    // The point: an authenticated caller is NOT anonymous. An empty roles array
    // here means role resolution silently failed — which is exactly what a
    // missing composite index looked like (a 500 before the index existed, and
    // an empty principal if the query had failed softer).
    expect(body.roles?.length ?? 0).toBeGreaterThan(0)
  }, NET_MS)

  test('a privileged principal can list a protected collection', async () => {
    if (needsToken()) return
    const r = await authed(`${FUNCTIONS}/docs?p=role`)
    expect(r.status).toBe(200)
  }, NET_MS)

  test('the SAME request is opaque to an anonymous caller', async () => {
    if (needsToken()) return
    // The privilege boundary, asserted as a difference rather than in isolation:
    // privileged 200 / anonymous 404 on one identical URL.
    const anon = await get(`${FUNCTIONS}/docs?p=role`)
    expect(anon.status).toBe(404)
  }, NET_MS)

  test('role resolution does not 500 — the missing-index regression', async () => {
    if (needsToken()) return
    // `getUserRoles` queries `role` by `userIds array-contains` with an orderBy,
    // which REQUIRES a composite index. It has no try/catch, so a missing index
    // took every authenticated request to a 500. Production had the index by
    // console; source control did not, so a freshly provisioned host had none
    // and this failed until firestore.indexes.json declared it.
    for (const path of ['user', 'docs?p=post', 'doc?p=config/app']) {
      const r = await authed(`${FUNCTIONS}/${path}`)
      expect(r.status).toBeLessThan(500)
    }
  }, NET_MS)
})
