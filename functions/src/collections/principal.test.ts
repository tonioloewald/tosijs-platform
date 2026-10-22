/**
 * The principal resolver, by BEHAVIOUR (SOVEREIGN-PLAN.md Phase 1).
 *
 * These replace regexes over `utilities.ts` (endpoint-wiring.test.ts, the B1,
 * B2, M1 and #28 groups) that existed only because the code could not run
 * without Firebase. Each test names the defect it keeps fixed.
 */
import { describe, test, expect } from 'bun:test'

import { MemoryStore } from './store'
import { resolvePrincipal, type Credential, type PrincipalDeps } from './principal'
import { anonymousUser } from './roles'
import { hashToken } from '../auth/token'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const SECRET = 'tsp_test-secret'

function setup(
  seed: Record<string, Record<string, unknown>>,
  credentials: Record<string, Credential> = {}
) {
  const store = new MemoryStore(seed)
  const logs: string[] = []
  const verified: string[] = []
  const synced: Array<[string, string[]]> = []
  const deps: PrincipalDeps = {
    store,
    verify: async (idToken) => {
      verified.push(idToken)
      return credentials[idToken] ?? null
    },
    log: { warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
    onResolved: async (uid, roles) => {
      synced.push([uid, roles])
    },
    now: () => NOW,
  }
  return { store, deps, logs, verified, synced }
}

const role = (created: string, fields: Record<string, unknown>) => ({ _created: created, ...fields })

const token = (fields: Record<string, unknown> = {}) => ({
  _created: '2026-10-01T00:00:00Z',
  hash: hashToken(SECRET),
  principalUid: 'u1',
  principalName: 'Tonio',
  label: 'Tosi × tosijs-platform',
  caveats: { roles: ['author', 'owner'] },
  expiresAt: '2026-11-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  createdBy: 'u1',
  ...fields,
})

describe('who is calling', () => {
  test('no header, or no Bearer, is anonymous and never reaches verify', async () => {
    const { deps, verified } = setup({})
    expect(await resolvePrincipal(undefined, deps)).toBe(anonymousUser)
    expect(await resolvePrincipal('Basic abc', deps)).toBe(anonymousUser)
    expect(verified).toEqual([])
  })

  test('an unverifiable sign-in token is anonymous (fails closed)', async () => {
    const { deps } = setup({ 'role/r1': role('2026-01-01', { roles: ['admin'], userIds: ['u1'] }) })
    expect(await resolvePrincipal('Bearer forged', deps)).toBe(anonymousUser)
  })

  test('a verified user with no role document is the shared anonymous identity', async () => {
    const { deps, synced } = setup({}, { t: { uid: 'nobody' } })
    expect(await resolvePrincipal('Bearer t', deps)).toBe(anonymousUser)
    expect(synced).toEqual([])
  })

  test('all matching role documents are JOINED, not the first one (B1)', async () => {
    const { deps, logs } = setup(
      {
        'role/a': role('2026-01-01', { name: 'A', roles: ['author'], userIds: ['u1'] }),
        'role/b': role('2026-02-01', { name: 'B', roles: ['admin'], userIds: ['u1'] }),
      },
      { t: { uid: 'u1' } }
    )
    const got = await resolvePrincipal('Bearer t', deps)
    expect([...got.roles].sort()).toEqual(['admin', 'author'])
    expect(logs.some((l) => l.includes('joining them'))).toBe(true)
  })

  test('resolution never WRITES: removing a uid is not undone by a read (B1)', async () => {
    const seed = {
      'role/r': role('2026-01-01', {
        roles: ['author'],
        userIds: [],
        contacts: [{ type: 'email', value: 'a@example.com' }],
      }),
    }
    const { deps, store } = setup(seed, {
      t: { uid: 'u1', email: 'a@example.com', email_verified: true },
    })
    await resolvePrincipal('Bearer t', deps)
    expect((await store.get('role/r')).data.userIds).toEqual([])
  })

  test('a VERIFIED email resolves a role by contact; an unverified one does not (M1)', async () => {
    const seed = {
      'role/r': role('2026-01-01', {
        roles: ['author'],
        contacts: [{ value: 'a@example.com', type: 'email' }], // key order differs
      }),
    }
    const { deps } = setup(seed, {
      ok: { uid: 'u1', email: 'a@example.com', email_verified: true },
      bad: { uid: 'u2', email: 'a@example.com' },
      falsy: { uid: 'u3', email: 'a@example.com', email_verified: 'yes' as unknown as boolean },
    })
    expect((await resolvePrincipal('Bearer ok', deps)).roles).toEqual(['author'])
    expect(await resolvePrincipal('Bearer bad', deps)).toBe(anonymousUser)
    expect(await resolvePrincipal('Bearer falsy', deps)).toBe(anonymousUser)
  })

  test('a contact stored with its original case still matches', async () => {
    const seed = {
      'role/r': role('2026-01-01', { roles: ['author'], contacts: [{ type: 'email', value: 'A@Example.com' }] }),
    }
    const { deps } = setup(seed, { t: { uid: 'u1', email: 'A@Example.com', email_verified: true } })
    expect((await resolvePrincipal('Bearer t', deps)).roles).toEqual(['author'])
  })

  test('a uid match wins; contacts are consulted only when it finds nothing', async () => {
    const seed = {
      'role/byUid': role('2026-01-01', { roles: ['author'], userIds: ['u1'] }),
      'role/byMail': role('2026-01-01', { roles: ['admin'], contacts: [{ type: 'email', value: 'a@example.com' }] }),
    }
    const { deps } = setup(seed, { t: { uid: 'u1', email: 'a@example.com', email_verified: true } })
    expect((await resolvePrincipal('Bearer t', deps)).roles).toEqual(['author'])
  })

  test('a soft-deleted role document grants nothing', async () => {
    const { deps } = setup(
      { 'role/r': role('2026-01-01', { roles: ['admin'], userIds: ['u1'], _deleted: true }) },
      { t: { uid: 'u1' } }
    )
    expect(await resolvePrincipal('Bearer t', deps)).toBe(anonymousUser)
  })

  test('the principal is WHO AUTHENTICATED, named by their credential, never their email (#28, B2)', async () => {
    const seed = { 'role/r': role('2026-01-01', { name: 'Shared', roles: ['author'], userIds: ['someone-else', 'u1'] }) }
    const { deps } = setup(seed, {
      named: { uid: 'u1', name: ' Tonio ', email: 'a@example.com' },
      unnamed: { uid: 'u1', email: 'a@example.com' },
    })
    expect((await resolvePrincipal('Bearer named', deps)).principal).toEqual({ uid: 'u1', name: 'Tonio' })
    expect((await resolvePrincipal('Bearer unnamed', deps)).principal).toEqual({ uid: 'u1' })
  })

  test('onResolved (the Firebase custom-claims sync) gets the joined roles', async () => {
    const { deps, synced } = setup(
      { 'role/r': role('2026-01-01', { roles: ['author'], userIds: ['u1'] }) },
      { t: { uid: 'u1' } }
    )
    await resolvePrincipal('Bearer t', deps)
    expect(synced).toEqual([['u1', ['author']]])
  })

  test('hitting the role-document bound is logged as an error', async () => {
    const seed: Record<string, Record<string, unknown>> = {}
    for (let i = 0; i < 12; i++) seed[`role/r${i}`] = role(`2026-01-${10 + i}`, { roles: ['author'], userIds: ['u1'] })
    const { deps, logs } = setup(seed, { t: { uid: 'u1' } })
    await resolvePrincipal('Bearer t', deps)
    expect(logs.some((l) => l.startsWith('error') && l.includes('bound'))).toBe(true)
  })
})

describe('capability tokens (B2, #6)', () => {
  const human = { 'role/r': role('2026-01-01', { name: 'Ops', roles: ['author', 'admin', 'owner'], userIds: ['u1'] }) }

  test('a token bearer is routed by prefix and never reaches verify', async () => {
    const { deps, verified } = setup({ ...human, 'token/k': token() })
    await resolvePrincipal(`Bearer ${SECRET}`, deps)
    expect(verified).toEqual([])
  })

  test('it ATTENUATES: the agent gets the caveat roles the human holds, minus never-by-token', async () => {
    const { deps } = setup({ ...human, 'token/k': token() })
    const got = await resolvePrincipal(`Bearer ${SECRET}`, deps)
    expect(got.roles).toEqual(['author'])
    expect(got.token).toMatchObject({ id: 'k', label: 'Tosi × tosijs-platform' })
  })

  test('the principal is read LIVE: revoking the human revokes the agent', async () => {
    const { deps } = setup({ 'role/r': role('2026-01-01', { roles: ['admin'], userIds: ['u1'] }), 'token/k': token() })
    expect(await resolvePrincipal(`Bearer ${SECRET}`, deps)).toBe(anonymousUser)
  })

  test('lookup is by HASH: an unknown secret is anonymous and logged', async () => {
    const { deps, logs } = setup({ ...human, 'token/k': token() })
    expect(await resolvePrincipal('Bearer tsp_other', deps)).toBe(anonymousUser)
    expect(logs).toContain('warn rejected an unknown capability token')
  })

  test('revoked and expired tokens are refused, with the reason logged', async () => {
    for (const [fields, reason] of [
      [{ revokedAt: '2026-10-10T00:00:00Z' }, 'revoked'],
      [{ expiresAt: '2026-10-21T00:00:00Z' }, 'expired'],
    ] as const) {
      const { deps, logs } = setup({ ...human, 'token/k': token(fields) })
      expect(await resolvePrincipal(`Bearer ${SECRET}`, deps)).toBe(anonymousUser)
      expect(logs).toContain(`warn token k refused: ${reason}`)
    }
  })

  test("the principal is the token's OWNER, named as at mint (#28)", async () => {
    const { deps } = setup({ ...human, 'token/k': token() })
    expect((await resolvePrincipal(`Bearer ${SECRET}`, deps)).principal).toEqual({ uid: 'u1', name: 'Tonio' })
  })

  test('a token never resolves its human by email', async () => {
    const { deps } = setup({
      'role/r': role('2026-01-01', { roles: ['author'], contacts: [{ type: 'email', value: 'u1' }] }),
      'token/k': token(),
    })
    expect(await resolvePrincipal(`Bearer ${SECRET}`, deps)).toBe(anonymousUser)
  })
})
