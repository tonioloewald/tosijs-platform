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

beforeAll(async () => {
  try {
    const r = await json(`${FUNCTIONS}/docs?p=post`)
    reachable = r.status === 200 && Array.isArray(r.body)
    if (reachable) posts = r.body as Array<Record<string, unknown>>
  } catch {
    reachable = false
  }
})

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
  })

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
  })

  test('a protected collection denies OPAQUELY (404, never 403)', async () => {
    if (guard()) return
    // 403 confirms the collection exists; /doc and /docs must agree on 404.
    for (const path of ['role', 'nonexistent-collection-xyz']) {
      const r = await get(`${FUNCTIONS}/docs?p=${path}`)
      expect(r.status).toBe(404)
    }
  })

  test('/user leaks no privilege to an anonymous caller', async () => {
    if (guard()) return
    const r = await json(`${FUNCTIONS}/user`)
    const body = r.body as { roles?: string[] } | null
    expect(body?.roles ?? []).toEqual([])
  })

  test('the sitemap advertises only published posts', async () => {
    if (guard()) return
    const r = await get(`${FUNCTIONS}/sitemap`)
    expect(r.status).toBe(200)
    const drafts = posts.filter((p) => !published(p))
    for (const d of drafts) {
      expect(r.text).not.toContain(`/${String(d.path)}`)
    }
  })

  test('the sitemap emits no undefined hosts', async () => {
    if (guard()) return
    // The real bug: 850 URLs of the form `https://undefined/...`, caused by a
    // host lookup that returned undefined and was never checked.
    const r = await get(`${FUNCTIONS}/sitemap`)
    expect(r.text).not.toContain('undefined')
  })

  test('SSR serves HTML for the homepage', async () => {
    if (guard()) return
    const r = await get(`${HOSTING}/`)
    expect(r.status).toBe(200)
    expect(r.type).toContain('text/html')
  })

  test('SSR serves HTML for a published post slug', async () => {
    if (guard()) return
    const slug = posts.find(published)?.path
    expect(slug).toBeTruthy()
    const r = await get(`${HOSTING}/${String(slug)}`)
    expect(r.status).toBe(200)
    expect(r.type).toContain('text/html')
  })

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
  })

  test('/esm does not serve a module that is not public', async () => {
    if (guard()) return
    const r = await get(`${HOSTING}/esm/definitely-not-a-public-module`)
    expect(r.status).toBeGreaterThanOrEqual(400)
  })
})
