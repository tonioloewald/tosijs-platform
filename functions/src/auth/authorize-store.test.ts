/**
 * The `/authorize` lifecycle over the store port, by behaviour
 * (SOVEREIGN-PLAN.md Phase 1).
 *
 * The endpoint used to read, decide and then write, so concurrent exchanges of
 * one approved request could each mint a credential. These run the kernel
 * against MemoryStore, whose transactions serialise, and race it.
 *
 * Run: cd functions && bun test src/auth/authorize-store.test.ts
 */
import { describe, test, expect } from 'bun:test'

import { MemoryStore } from '../collections/store'
import { AUTHORIZE_COLLECTION, REQUEST_TTL_MS, sha256Base64Url, type AuthorizeRequest } from './authorize'
import { hashToken } from './token'
import { approveRequest, denyRequest, exchangeRequest, readRequest, TOKEN_COLLECTION } from './authorize-store'

const NOW = new Date('2026-10-27T12:00:00.000Z')
const VERIFIER = 'v'.repeat(43)
const PATH = `${AUTHORIZE_COLLECTION}/r1`

const request = (over: Partial<AuthorizeRequest> = {}) =>
  ({
    label: 'ci × tosijs-platform',
    caveats: { roles: ['author'] },
    ttlMs: 3_600_000,
    codeChallenge: sha256Base64Url(VERIFIER),
    mode: 'poll',
    status: 'pending',
    expiresAt: new Date(NOW.getTime() + REQUEST_TTL_MS).toJSON(),
    createdAt: NOW.toJSON(),
    ...over,
  }) as unknown as Record<string, unknown>

const approved = (over: Partial<AuthorizeRequest> = {}) =>
  request({ status: 'approved', approvedBy: 'human', approvedByName: 'Ada', ...over } as Partial<AuthorizeRequest>)

const deps = (roles: string[] = ['author', 'editor']) => ({ rolesOf: async () => roles, now: () => NOW })
const tokens = (store: MemoryStore) => store.paths().filter((p) => p.startsWith(`${TOKEN_COLLECTION}/`))

describe('readRequest', () => {
  test('carries its id; missing or empty is null', async () => {
    const store = new MemoryStore({ [PATH]: request() })
    expect((await readRequest(store, 'r1'))?._id).toBe('r1')
    expect(await readRequest(store, 'nope')).toBeNull()
    expect(await readRequest(store, '')).toBeNull()
  })
})

describe('approve and deny', () => {
  test('approval records who, and does not mint', async () => {
    const store = new MemoryStore({ [PATH]: request() })
    const { decision } = await approveRequest(store, 'r1', { uid: 'human', name: 'Ada' }, NOW)
    expect(decision.status).toBe('approved')
    expect((await store.get(PATH)).data).toMatchObject({ status: 'approved', approvedBy: 'human', approvedByName: 'Ada' })
    expect(tokens(store)).toEqual([])
  })

  test('approval racing a denial: exactly one lands', async () => {
    const store = new MemoryStore({ [PATH]: request() })
    const [a, d] = await Promise.all([
      approveRequest(store, 'r1', { uid: 'human' }, NOW),
      denyRequest(store, 'r1'),
    ])
    expect([a.decision.status === 'approved', d].filter(Boolean)).toHaveLength(1)
  })

  test('a denial never overwrites an approval', async () => {
    const store = new MemoryStore({ [PATH]: approved() })
    expect(await denyRequest(store, 'r1')).toBe(false)
    expect((await store.get(PATH)).data.status).toBe('approved')
  })
})

describe('exchangeRequest', () => {
  test('mints from LIVE roles and consumes the request in the same commit', async () => {
    const store = new MemoryStore({ [PATH]: approved() })
    const out = await exchangeRequest(store, 'r1', VERIFIER, deps())
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    const token = (await store.get(`${TOKEN_COLLECTION}/${out.tokenId}`)).data
    expect(token).toMatchObject({ principalUid: 'human', principalName: 'Ada', hash: hashToken(out.secret) })
    expect(JSON.stringify(token)).not.toContain(out.secret)
    expect((await store.get(PATH)).data.usedAt).toBeTruthy()
  })

  test('a revocation between approving and collecting takes effect', async () => {
    const store = new MemoryStore({ [PATH]: approved() })
    expect((await exchangeRequest(store, 'r1', VERIFIER, deps([]))).status).toBe('mint-refused')
    expect(tokens(store)).toEqual([])
    expect((await store.get(PATH)).data.usedAt).toBeUndefined()
  })

  test('single use: a second exchange is refused', async () => {
    const store = new MemoryStore({ [PATH]: approved() })
    await exchangeRequest(store, 'r1', VERIFIER, deps())
    expect(await exchangeRequest(store, 'r1', VERIFIER, deps())).toEqual({ status: 'refused', reason: 'used' })
  })

  test('two SIMULTANEOUS exchanges of one request mint ONE token', async () => {
    const store = new MemoryStore({ [PATH]: approved() })
    const outs = await Promise.all([1, 2, 3].map(() => exchangeRequest(store, 'r1', VERIFIER, deps())))
    expect(outs.filter((o) => o.status === 'ready')).toHaveLength(1)
    expect(tokens(store)).toHaveLength(1)
  })

  test('pending stays pending; a wrong verifier learns nothing and writes nothing', async () => {
    const store = new MemoryStore({ [PATH]: request() })
    expect(await exchangeRequest(store, 'r1', VERIFIER, deps())).toEqual({ status: 'pending' })
    expect(await exchangeRequest(store, 'r1', 'w'.repeat(43), deps())).toEqual({ status: 'refused', reason: 'bad-verifier' })
    expect(store.paths()).toEqual([PATH])
  })
})
