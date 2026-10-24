/**
 * The claim ceremony's transactions, by behaviour (SOVEREIGN-PLAN.md Phase 1).
 *
 * `claim.ts` needed Firestore, so "one transaction, rotation inside it" was
 * pinned by regexes over its source. These run the real ceremony against
 * MemoryStore — including the race the transaction exists for.
 *
 * Run: cd functions && bun test src/install/claim-ceremony.test.ts
 */
import { describe, test, expect } from 'bun:test'

import { MemoryStore } from '../collections/store'
import { ROLES } from '../collections/roles'
import { CLAIM_PATH, NONCE_TTL_MS, type ClaimState } from './claim'
import { claimConfigurator, publishNonce, type Claimant } from './claim-ceremony'

const NOW = Date.parse('2026-10-24T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toJSON()

function setup(state?: ClaimState, seed: Record<string, Record<string, unknown>> = {}) {
  const store = new MemoryStore({
    ...(state ? { [CLAIM_PATH]: state as Record<string, unknown> } : {}),
    ...seed,
  })
  let n = 0
  const deps = {
    now: () => NOW,
    nonce: () => `nonce-${++n}`,
    newId: (c: string) => `${c}-id-${++n}`,
  }
  return { store, deps }
}

const armed = (over: Partial<ClaimState> = {}): ClaimState => ({
  nonce: 'live',
  issuedAt: iso(NOW - 1000),
  proof: 'live',
  ...over,
})
const alice: Claimant = { uid: 'alice-uid-123', email: 'a@example.com', email_verified: true, name: 'Alice' }

describe('publishNonce', () => {
  test('mints when there is none, and stores it', async () => {
    const { store, deps } = setup()
    const state = await publishNonce(store, deps)
    expect(state).toEqual({ nonce: 'nonce-1', issuedAt: iso(NOW) })
    expect((await store.get(CLAIM_PATH)).data).toEqual(state)
  })

  test('reuses a fresh nonce, so an open GET cannot rotate it away', async () => {
    const { store, deps } = setup({ nonce: 'live', issuedAt: iso(NOW - 1000) })
    expect((await publishNonce(store, deps)).nonce).toBe('live')
  })

  test('re-mints an expired one, clearing the stale proof and binding, keeping the ledger', async () => {
    const { store, deps } = setup({
      nonce: 'old',
      issuedAt: iso(NOW - NONCE_TTL_MS - 1),
      proof: 'old',
      for: 'a@example.com',
      claimedBy: 'earlier',
    })
    const state = await publishNonce(store, deps)
    expect(state).toEqual({ nonce: 'nonce-1', issuedAt: iso(NOW), claimedBy: 'earlier' })
    expect((await store.get(CLAIM_PATH)).data).toEqual(state)
  })
})

describe('claimConfigurator', () => {
  test('grants configurator on a NEW role document, rotates, and logs', async () => {
    const { store, deps } = setup(armed())
    expect(await claimConfigurator(store, alice, deps)).toEqual({
      status: 'granted',
      principal: alice.uid,
      rotate: true,
      reclaim: false,
    })
    const roles = await store.query('role', { orderBy: '~' })
    expect(roles).toHaveLength(1)
    expect(roles[0].data).toMatchObject({
      name: 'Alice',
      contacts: [{ type: 'email', value: 'a@example.com' }],
      roles: [ROLES.configurator],
      userIds: [alice.uid],
    })
    const claim = (await store.get(CLAIM_PATH)).data
    expect(claim).toEqual({ nonce: 'nonce-1', issuedAt: iso(NOW), claimedBy: alice.uid, claimedAt: iso(NOW) })
    const log = await store.query('install-log', { orderBy: '~' })
    expect(log.map((d) => d.data)).toEqual([{ at: iso(NOW), by: alice.uid, action: 'claim', granted: ROLES.configurator }])
  })

  test('adds configurator to an EXISTING role document, keeping its other fields', async () => {
    const { store, deps } = setup(armed(), {
      'role/mine': { name: 'Me', roles: [ROLES.author], userIds: [alice.uid], contacts: [] },
    })
    await claimConfigurator(store, alice, deps)
    expect((await store.get('role/mine')).data).toEqual({
      name: 'Me',
      roles: [ROLES.author, ROLES.configurator],
      userIds: [alice.uid],
      contacts: [],
      _modified: iso(NOW),
    })
    expect(store.paths().filter((p) => p.startsWith('role/'))).toEqual(['role/mine'])
  })

  test('an unverified email is never recorded as a contact, and never names the role', async () => {
    const { store, deps } = setup(armed())
    await claimConfigurator(store, { uid: 'bob-uid-4567', email: 'b@example.com', email_verified: false }, deps)
    const [role] = await store.query('role', { orderBy: '~' })
    expect(role.data).toMatchObject({ name: 'Host owner bob-uid-', contacts: [] })
  })

  test('a verified email with no display name still never names the role (0.2.1 re-review)', async () => {
    const { store, deps } = setup(armed())
    await claimConfigurator(store, { uid: 'carol-uid-89', email: 'c@example.com', email_verified: true }, deps)
    const [role] = await store.query('role', { orderBy: '~' })
    expect(role.data).toMatchObject({ name: 'Host owner carol-ui', contacts: [{ type: 'email', value: 'c@example.com' }] })
    expect(JSON.stringify(role.data.name)).not.toContain('@')
  })

  test('a re-claim is conspicuous in the ledger', async () => {
    const { store, deps } = setup(armed({ claimedBy: 'earlier', claimedAt: iso(NOW - 5000) }))
    expect(await claimConfigurator(store, alice, deps)).toMatchObject({ reclaim: true })
    const [log] = await store.query('install-log', { orderBy: '~' })
    expect(log.data.action).toBe('claim-again')
  })

  test('a refusal writes NOTHING', async () => {
    const { store, deps } = setup(armed({ proof: 'wrong' }))
    expect(await claimConfigurator(store, alice, deps)).toEqual({ status: 'refused', reason: 'mismatch' })
    expect(store.paths()).toEqual([CLAIM_PATH])
    expect((await store.get(CLAIM_PATH)).data.proof).toBe('wrong')
  })

  test('the proof is one-time: a second claim against it is refused', async () => {
    const { store, deps } = setup(armed())
    await claimConfigurator(store, alice, deps)
    expect(await claimConfigurator(store, { uid: 'mallory' }, deps)).toEqual({ status: 'refused', reason: 'no-proof' })
  })

  test('two SIMULTANEOUS claims against one proof: exactly one is granted', async () => {
    const { store, deps } = setup(armed())
    const outcomes = await Promise.all([
      claimConfigurator(store, alice, deps),
      claimConfigurator(store, { uid: 'mallory-uid' }, deps),
    ])
    expect(outcomes.map((o) => o.status).sort()).toEqual(['granted', 'refused'])
    expect(await store.query('role', { orderBy: '~' })).toHaveLength(1)
    expect(await store.query('install-log', { orderBy: '~' })).toHaveLength(1)
  })
})
