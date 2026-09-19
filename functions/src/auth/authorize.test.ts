/**
 * Browser-loop authorization (B2, #6).
 *
 * The flow hands a command line real authority on the strength of a human
 * clicking a button in a browser, so these are almost all about what it
 * refuses and what it declines to reveal.
 *
 * Run: cd functions && bun test src/auth/authorize.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import {
  decideStart,
  decideApprove,
  decideExchange,
  sha256Base64Url,
  newVerifier,
  loopbackRedirect,
  REQUEST_TTL_MS,
  type AuthorizeRequest,
} from './authorize'

const NOW = '2026-09-20T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const VERIFIER = 'a'.repeat(43)
const CHALLENGE = sha256Base64Url(VERIFIER)

const start = (over: Record<string, unknown> = {}) =>
  decideStart({
    label: 'ci × tosijs-platform',
    caveats: { roles: ['author'] },
    codeChallenge: CHALLENGE,
    mode: 'loopback',
    redirectPort: 8123,
    nowIso: NOW,
    ...over,
  })

const problems = (d: ReturnType<typeof decideStart>) =>
  (d as { problems: string[] }).problems.join('\n')

const request = (over: Partial<AuthorizeRequest> = {}): AuthorizeRequest => ({
  _id: 'r1',
  label: 'ci × tosijs-platform',
  caveats: { roles: ['author'] },
  ttlMs: 60_000,
  codeChallenge: CHALLENGE,
  mode: 'loopback',
  redirectPort: 8123,
  status: 'pending',
  expiresAt: new Date(NOW_MS + REQUEST_TTL_MS).toJSON(),
  createdAt: NOW,
  ...over,
})

describe('starting a request', () => {
  test('a well-formed request starts', () => {
    expect(start().status).toBe('started')
  })

  test('a label is required — it is the provenance', () => {
    expect(problems(start({ label: '' }))).toContain('names the agent context')
  })

  test('the challenge must actually look like one', () => {
    for (const bad of ['', 'short', 'has spaces in it '.repeat(3), 42]) {
      expect(problems(start({ codeChallenge: bad }))).toContain('codeChallenge')
    }
  })

  test('roles must be stated at START, so the human can be shown them', () => {
    expect(problems(start({ caveats: {} }))).toContain('caveats.roles" is required')
    expect(problems(start({ caveats: { roles: [] } }))).toContain('is required')
  })

  test('loopback requires an UNPRIVILEGED port', () => {
    // A consent page that can be redirected at a privileged port is a small
    // SSRF primitive aimed at the user's own machine.
    for (const port of [0, 80, 443, 1023, 65536, 'abc']) {
      expect(problems(start({ redirectPort: port }))).toContain('unprivileged port')
    }
    expect(start({ redirectPort: 1024 }).status).toBe('started')
  })

  test('poll mode needs no port', () => {
    expect(start({ mode: 'poll', redirectPort: undefined }).status).toBe('started')
  })

  test('an unknown mode is refused rather than defaulted', () => {
    // Defaulting would silently pick a security posture for the caller.
    expect(problems(start({ mode: 'whatever' }))).toContain('must be "loopback"')
  })

  test('the request lifetime is capped', () => {
    // An outstanding request is an outstanding invitation to approve
    // something.
    expect(problems(start({ ttlMs: REQUEST_TTL_MS + 1 }))).toContain('no greater than')
    expect(problems(start({ ttlMs: 0 }))).toContain('positive number')
  })
})

describe('approving records WHO, and does not mint', () => {
  test('a pending request is approved', () => {
    const d = decideApprove(request(), 'u1', NOW_MS, NOW)
    expect(d).toMatchObject({ status: 'approved' })
    expect((d as { patch: Partial<AuthorizeRequest> }).patch).toEqual({
      status: 'approved',
      approvedBy: 'u1',
      approvedAt: NOW,
    })
  })

  test('the patch contains no secret and no caveats', () => {
    // Minting happens at EXCHANGE, from live roles. A token minted here and
    // collected later could outlive a revocation in between — and its secret
    // would have to be stored, which nothing else in this system does.
    const patch = (
      decideApprove(request(), 'u1', NOW_MS, NOW) as {
        patch: Record<string, unknown>
      }
    ).patch
    expect(Object.keys(patch).sort()).toEqual([
      'approvedAt',
      'approvedBy',
      'status',
    ])
  })

  test('an expired or already-decided request cannot be approved', () => {
    expect(decideApprove(request(), 'u1', NOW_MS + REQUEST_TTL_MS, NOW)).toMatchObject({
      reason: 'expired',
    })
    expect(
      decideApprove(request({ status: 'approved' }), 'u1', NOW_MS, NOW)
    ).toMatchObject({ reason: 'already-decided' })
    expect(
      decideApprove(request({ status: 'denied' }), 'u1', NOW_MS, NOW)
    ).toMatchObject({ reason: 'already-decided' })
  })

  test('an unknown request is refused', () => {
    expect(decideApprove(null, 'u1', NOW_MS, NOW)).toMatchObject({ reason: 'unknown' })
  })
})

describe('exchanging', () => {
  test('the verifier is checked BEFORE anything is revealed', () => {
    // Without this ordering, a caller holding only a request id could poll and
    // learn whether somebody had approved it — turning the CLI's capability
    // into an open query.
    const approved = request({ status: 'approved', approvedBy: 'u1' })
    expect(decideExchange(approved, 'wrong', NOW_MS)).toMatchObject({
      reason: 'bad-verifier',
    })
    // Same answer for a pending one, a used one and an expired one.
    expect(decideExchange(request(), 'wrong', NOW_MS)).toMatchObject({
      reason: 'bad-verifier',
    })
    expect(
      decideExchange(request({ usedAt: NOW }), 'wrong', NOW_MS)
    ).toMatchObject({ reason: 'bad-verifier' })
  })

  test('a pending request says pending, and nothing else', () => {
    const d = decideExchange(request(), VERIFIER, NOW_MS)
    expect(d).toEqual({ status: 'pending' })
  })

  test('an approved request yields the pinned caveats and the approver', () => {
    const d = decideExchange(
      request({ status: 'approved', approvedBy: 'u1' }),
      VERIFIER,
      NOW_MS
    )
    expect(d).toMatchObject({
      status: 'ready',
      principalUid: 'u1',
      label: 'ci × tosijs-platform',
      caveats: { roles: ['author'] },
    })
  })

  test('it is good for exactly ONE token', () => {
    expect(
      decideExchange(
        request({ status: 'approved', approvedBy: 'u1', usedAt: NOW }),
        VERIFIER,
        NOW_MS
      )
    ).toMatchObject({ reason: 'used' })
  })

  test('denial and expiry are distinct from pending', () => {
    expect(
      decideExchange(request({ status: 'denied' }), VERIFIER, NOW_MS)
    ).toMatchObject({ reason: 'denied' })
    expect(
      decideExchange(request(), VERIFIER, NOW_MS + REQUEST_TTL_MS)
    ).toMatchObject({ reason: 'expired' })
  })

  test('a missing or unparseable expiry reads as expired, never as forever', () => {
    for (const expiresAt of [undefined, '', 'soon'] as never[]) {
      expect(
        decideExchange(request({ expiresAt }), VERIFIER, NOW_MS)
      ).toMatchObject({ reason: 'expired' })
    }
  })
})

describe('PKCE, end to end', () => {
  test('a fresh verifier round-trips', () => {
    const v = newVerifier()
    const started = start({ codeChallenge: sha256Base64Url(v) })
    expect(started.status).toBe('started')
    const record = request({
      codeChallenge: sha256Base64Url(v),
      status: 'approved',
      approvedBy: 'u1',
    })
    expect(decideExchange(record, v, NOW_MS).status).toBe('ready')
    expect(decideExchange(record, newVerifier(), NOW_MS)).toMatchObject({
      reason: 'bad-verifier',
    })
  })

  test('the challenge does not reveal the verifier', () => {
    const v = newVerifier()
    expect(sha256Base64Url(v)).not.toContain(v)
    expect(v.length).toBeGreaterThanOrEqual(32)
  })
})

describe('the loopback redirect is not caller-controlled', () => {
  test('only the port varies, and the host is a literal address', () => {
    // Never `localhost`: that resolves through whatever DNS the machine is
    // using, and has been made to point elsewhere before.
    const url = loopbackRedirect(8123, 'req-1')
    expect(url.startsWith('http://127.0.0.1:8123/')).toBe(true)
    expect(url).not.toContain('localhost')
  })

  test('a request id cannot break out of the query string', () => {
    expect(loopbackRedirect(8123, 'a&b=c')).toContain('request=a%26b%3Dc')
  })
})
