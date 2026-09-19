/**
 * Scoped capability tokens (B2, #6).
 *
 * A token is a bearer secret that will live in a file on a build machine, so
 * these tests are almost entirely about what it CANNOT do. The single property
 * everything else hangs off: a token's authority is recomputed live from its
 * principal on every request, so it can never hold what its principal does not
 * hold right now.
 *
 * Run: cd functions && bun test src/auth/token.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import {
  decideMint,
  tokenAuthority,
  caveatsAllow,
  NEVER_BY_TOKEN,
  DEFAULT_METHODS,
  MAX_TTL_MS,
  type TokenRecord,
  type TokenAuthority,
} from './token'
import { ROLES } from '../collections/roles'

const NOW = '2026-09-19T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const DAY = 24 * 60 * 60 * 1000

const mint = (over: Record<string, unknown> = {}) =>
  decideMint({
    principalUid: 'u1',
    principalRoles: [ROLES.author, ROLES.editor, ROLES.admin],
    viaToken: false,
    label: 'macbook × tosijs-platform',
    caveats: { roles: [ROLES.author] },
    ttlMs: 30 * DAY,
    nowIso: NOW,
    ...over,
  } as never)

const problems = (d: ReturnType<typeof decideMint>) =>
  (d as { problems: string[] }).problems.join('\n')

const record = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  _id: 't1',
  hash: 'irrelevant-here',
  principalUid: 'u1',
  label: 'macbook × tosijs-platform',
  caveats: { roles: [ROLES.author], methods: [...DEFAULT_METHODS] },
  expiresAt: new Date(NOW_MS + DAY).toJSON(),
  createdAt: NOW,
  createdBy: 'u1',
  ...over,
})

describe('minting attenuates and nothing else', () => {
  test('a normal mint succeeds', () => {
    const d = mint()
    expect(d.status).toBe('minted')
  })

  test('you cannot delegate a role you do not hold', () => {
    // The check that makes "attenuate, never grant" true at mint time. It is
    // enforced again per request, which is the one that actually matters.
    expect(problems(mint({ caveats: { roles: [ROLES.owner] } }))).toContain(
      'may never be carried by a token'
    )
    expect(
      problems(
        mint({
          principalRoles: [ROLES.author],
          caveats: { roles: [ROLES.admin] },
        })
      )
    ).toContain('you do not hold "admin"')
  })

  test('the crown jewels are refused even from a principal who holds them', () => {
    // owner rewrites everyone's authority; configurator installs arbitrary
    // collections; developer writes `module`, which /esm serves as executable
    // JavaScript. None of those belong to a secret in a file.
    for (const role of NEVER_BY_TOKEN) {
      const d = mint({
        principalRoles: [...NEVER_BY_TOKEN, ROLES.author],
        caveats: { roles: [role] },
      })
      expect(d.status).toBe('refused')
      expect(problems(d)).toContain('human at an interactive session')
    }
  })

  test('a TOKEN cannot mint a token', () => {
    const d = mint({ viaToken: true })
    expect(d.status).toBe('refused')
    expect(problems(d)).toContain('may not mint another token')
  })

  test('roles are REQUIRED, never defaulted to everything', () => {
    // A default would make the widest token the easiest one to mint.
    expect(problems(mint({ caveats: {} }))).toContain('caveats.roles" is required')
    expect(problems(mint({ caveats: { roles: [] } }))).toContain('is required')
  })

  test('a label is required — it is the provenance', () => {
    expect(problems(mint({ label: '' }))).toContain('names the agent context')
    expect(problems(mint({ label: '  ' }))).toContain('names the agent context')
  })

  test('DELETE is not granted by default', () => {
    // #6: "read all; write owned/subscribed; no delete". The destructive
    // credential should be the deliberate one.
    const d = mint()
    const caveats = (d as { record: { caveats: { methods: string[] } } }).record.caveats
    expect(caveats.methods).not.toContain('DELETE')
    expect(caveats.methods).toEqual([...DEFAULT_METHODS])
  })

  test('DELETE can be asked for explicitly', () => {
    const d = mint({ caveats: { roles: [ROLES.author], methods: ['GET', 'DELETE'] } })
    expect(d.status).toBe('minted')
    expect(
      (d as { record: { caveats: { methods: string[] } } }).record.caveats.methods
    ).toEqual(['GET', 'DELETE'])
  })

  test('an invented method is refused', () => {
    expect(
      problems(mint({ caveats: { roles: [ROLES.author], methods: ['YOLO'] } }))
    ).toContain('is not a method')
  })

  test('lifetime is bounded', () => {
    expect(problems(mint({ ttlMs: MAX_TTL_MS + 1 }))).toContain('exceeds the maximum')
    expect(problems(mint({ ttlMs: 0 }))).toContain('must be a positive number')
    expect(mint({ ttlMs: MAX_TTL_MS }).status).toBe('minted')
  })

  test('every problem is reported, not just the first', () => {
    const d = mint({ label: '', caveats: {}, ttlMs: -1 })
    expect((d as { problems: string[] }).problems.length).toBeGreaterThan(2)
  })
})

describe('authority is recomputed live — the whole design', () => {
  test('a healthy token resolves to its caveat roles', () => {
    const a = tokenAuthority(record(), [ROLES.author, ROLES.admin], NOW_MS)
    expect(a).toMatchObject({ status: 'ok', roles: [ROLES.author] })
  })

  test('it can never exceed what the principal holds NOW', () => {
    // The token says `author`; the principal has been demoted. Not "author
    // until the token expires" — nothing, immediately.
    const a = tokenAuthority(record(), [], NOW_MS)
    expect(a).toMatchObject({ status: 'refused', reason: 'principal-has-nothing' })
  })

  test('revoking the human revokes their agents, with no revocation list', () => {
    const agent = record({ caveats: { roles: [ROLES.author, ROLES.editor] } })
    expect(
      (tokenAuthority(agent, [ROLES.author, ROLES.editor], NOW_MS) as never as {
        roles: string[]
      }).roles
    ).toEqual([ROLES.author, ROLES.editor])
    // The human loses `editor` only.
    expect(
      (tokenAuthority(agent, [ROLES.author], NOW_MS) as never as { roles: string[] })
        .roles
    ).toEqual([ROLES.author])
    // …and then everything.
    expect(tokenAuthority(agent, [], NOW_MS).status).toBe('refused')
  })

  test('a crown jewel in a stored record is stripped, not honoured', () => {
    // Defence in depth: `decideMint` refuses these, so a record containing one
    // arrived some other way — a direct datastore write, a restored backup, a
    // record minted before the rule existed.
    const smuggled = record({
      caveats: { roles: [ROLES.owner, ROLES.configurator, ROLES.author] },
    })
    const a = tokenAuthority(
      smuggled,
      [ROLES.owner, ROLES.configurator, ROLES.author],
      NOW_MS
    )
    expect((a as never as { roles: string[] }).roles).toEqual([ROLES.author])
  })

  test('an unknown, revoked or expired token is refused distinctly', () => {
    expect(tokenAuthority(null, [ROLES.author], NOW_MS)).toMatchObject({
      reason: 'unknown',
    })
    expect(
      tokenAuthority(record({ revokedAt: NOW }), [ROLES.author], NOW_MS)
    ).toMatchObject({ reason: 'revoked' })
    expect(
      tokenAuthority(record(), [ROLES.author], NOW_MS + 2 * DAY)
    ).toMatchObject({ reason: 'expired' })
  })

  test('a MISSING or unparseable expiry reads as expired, never as forever', () => {
    for (const expiresAt of [undefined, '', 'whenever'] as never[]) {
      expect(
        tokenAuthority(record({ expiresAt }), [ROLES.author], NOW_MS)
      ).toMatchObject({ reason: 'expired' })
    }
  })

  test('expiry is exclusive at the boundary', () => {
    const expires = NOW_MS + DAY
    expect(tokenAuthority(record(), [ROLES.author], expires - 1).status).toBe('ok')
    expect(tokenAuthority(record(), [ROLES.author], expires).status).toBe('refused')
  })
})

describe('caveats restrict along axes roles do not have', () => {
  const ok = (over: Partial<TokenRecord> = {}) =>
    tokenAuthority(record(over), [ROLES.author], NOW_MS) as Extract<
      TokenAuthority,
      { status: 'ok' }
    >

  test('a method outside the caveat is refused', () => {
    const a = ok()
    expect(caveatsAllow(a, 'POST', 'post')).toBe(true)
    expect(caveatsAllow(a, 'DELETE', 'post')).toBe(false)
  })

  test('no collection caveat means every collection', () => {
    expect(caveatsAllow(ok(), 'GET', 'anything')).toBe(true)
  })

  test('a collection caveat confines the token', () => {
    const a = ok({
      caveats: {
        roles: [ROLES.author],
        methods: [...DEFAULT_METHODS],
        collections: ['virta:task'],
      },
    })
    expect(caveatsAllow(a, 'GET', 'virta:task')).toBe(true)
    expect(caveatsAllow(a, 'GET', 'post')).toBe(false)
  })

  test('sub-collections are covered, lookalikes are not', () => {
    const a = ok({
      caveats: {
        roles: [ROLES.author],
        methods: [...DEFAULT_METHODS],
        collections: ['virta:task'],
      },
    })
    expect(caveatsAllow(a, 'GET', 'virta:task/comment')).toBe(true)
    // The `/` is what stops a prefix match reaching a different collection
    // that merely starts with the same characters.
    expect(caveatsAllow(a, 'GET', 'virta:taskish')).toBe(false)
    expect(caveatsAllow(a, 'GET', 'virta:task-secrets')).toBe(false)
  })
})
