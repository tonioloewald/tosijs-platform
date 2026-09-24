/**
 * Shared fetch for the integration suites, plus its own tests.
 *
 * Lives in a `*.test.ts` file so it is excluded from the deployed build
 * (tsconfig excludes `src/**\/*.test.ts`) while still being importable by the
 * other integration files.
 *
 * ## Why this exists
 *
 * `bun test` runs test FILES in parallel. Once there were several integration
 * suites, they hit the functions emulator hard enough to trip its rate limit and
 * every one of them failed with 429 — 24 tests that pass individually failing
 * together. That is a flaky suite reporting failures that are not real, which is
 * the mirror image of the skip-guard problem (a suite reporting passes that are
 * not real). Both lie about the state of the code.
 *
 * A 429 means "retry", not "denied", so treating it as a failure was simply
 * wrong. This retries with backoff and only surfaces a 429 if it persists.
 */
import { describe, test, expect } from 'bun:test'

/**
 * Write a role document straight into the Firestore EMULATOR, bypassing /doc.
 *
 * The integration suites used to authenticate as the seeded `owner@gmail.com`,
 * whose seeded role granted everything. That seed was a claimable grant on
 * every real host it touched (#23) and now grants nothing, so a suite that
 * needs an owner mints one: an identity of its own plus a role document keyed
 * on the uid the emulator assigned. `Bearer owner` is the emulator's admin
 * credential, which is what lets this skip the endpoint — it works against an
 * emulator and nowhere else.
 *
 * `_created` is written deliberately: role lookup orders by it, and a role
 * document without it is invisible (#24).
 */
export async function grantEmulatorRoles(
  projectId: string,
  docId: string,
  uid: string,
  roles: string[]
): Promise<boolean> {
  const res = await emulatorFetch(
    `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents/role/${docId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({
        fields: {
          name: { stringValue: docId },
          roles: { arrayValue: { values: roles.map((r) => ({ stringValue: r })) } },
          userIds: { arrayValue: { values: [{ stringValue: uid }] } },
          contacts: { arrayValue: { values: [] } },
          _created: { stringValue: new Date().toJSON() },
        },
      }),
    }
  )
  return res.ok
}

/** Every role, for a suite that needs an owner. */
export const ALL_ROLES = ['owner', 'developer', 'admin', 'editor', 'author']

const RETRY_STATUSES = new Set([429, 503])

/** fetch that retries throttling responses instead of reporting them as results. */
export async function emulatorFetch(
  url: string,
  init?: RequestInit,
  attempts = 5
): Promise<Response> {
  let last: Response | undefined
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, init)
    if (!RETRY_STATUSES.has(res.status)) return res
    last = res
    // 50ms, 100, 200, 400 — enough for an emulator, invisible to a human
    await new Promise((r) => setTimeout(r, 50 * 2 ** i))
  }
  return last as Response
}

describe('emulatorFetch retries throttling, not denials', () => {
  const server = (statuses: number[]) => {
    let n = 0
    const seen: number[] = []
    globalThis.fetch = (async () => {
      const s = statuses[Math.min(n, statuses.length - 1)]
      seen.push(s)
      n++
      return new Response('', { status: s })
    }) as typeof fetch
    return { calls: () => n, seen }
  }
  const realFetch = globalThis.fetch

  test('a 429 that clears is retried and the real answer returned', async () => {
    const s = server([429, 429, 200])
    const res = await emulatorFetch('http://x')
    globalThis.fetch = realFetch
    expect(res.status).toBe(200)
    expect(s.calls()).toBe(3)
  })

  test('a persistent 429 is eventually surfaced rather than looping', async () => {
    const s = server([429])
    const res = await emulatorFetch('http://x', undefined, 3)
    globalThis.fetch = realFetch
    expect(res.status).toBe(429)
    expect(s.calls()).toBe(3)
  })

  test('a 403 is NOT retried — a denial is an answer', async () => {
    const s = server([403])
    const res = await emulatorFetch('http://x')
    globalThis.fetch = realFetch
    expect(res.status).toBe(403)
    expect(s.calls()).toBe(1)
  })

  test('a 404 is NOT retried', async () => {
    const s = server([404])
    const res = await emulatorFetch('http://x')
    globalThis.fetch = realFetch
    expect(res.status).toBe(404)
    expect(s.calls()).toBe(1)
  })

  test('a 200 costs exactly one call', async () => {
    const s = server([200])
    await emulatorFetch('http://x')
    globalThis.fetch = realFetch
    expect(s.calls()).toBe(1)
  })
})
