/**
 * The transactional commit, by behaviour (SOVEREIGN-PLAN.md Phase 1).
 *
 * `commit.ts` needed Firestore, so its guarantees were pinned by regexes over
 * its source. These run the real `commitWrites` against MemoryStore, whose
 * transactions are serialised, buffered and discarded on a throw — so
 * atomicity and the concurrent-create race are tested, not described.
 */
import { describe, test, expect } from 'bun:test'

import { MemoryStore } from './store'
import { commitWrites } from './commit'
import { ROLES, type UserRoles, type RoleName } from './roles'
import { ALL, type CollectionConfig, type CollectionMap } from './access'
import { SEQ_COLLECTION } from './sequence'

const admin: UserRoles = {
  name: 'Test',
  contacts: [],
  roles: [ROLES.admin] as RoleName[],
  userIds: ['uid'],
}
const NOW = '2026-10-22T00:00:00.000Z'
const access = { [ROLES.admin]: { read: ALL, write: ALL, list: ALL, delete: true } }

function setup(extra: Partial<CollectionConfig> = {}, seed: Record<string, Record<string, unknown>> = {}) {
  const after: Array<[string, unknown]> = []
  const warnings: string[] = []
  const collections = {
    note: { unique: ['slug'], access, ...extra },
    log: { access, seq: true, immutable: true },
  } as unknown as CollectionMap
  ;(collections.note as CollectionConfig).afterWrite = async (data, _roles, change) => {
    if (data.explode) throw new Error('hook failed')
    after.push([change?.path as string, change?.before])
  }
  const store = new MemoryStore(seed)
  const commit = (writes: Parameters<typeof commitWrites>[1]) =>
    commitWrites(store, writes, collections, admin, {
      now: () => NOW,
      warn: (m) => warnings.push(m),
    })
  return { store, commit, after, warnings }
}

describe('a commit is all or nothing', () => {
  test('a refusal anywhere writes NOTHING, and names the document', async () => {
    const { store, commit } = setup({}, { 'note/taken': { slug: 'x' } })
    const outcome = await commit([
      { p: 'note/a', data: { slug: 'fine' } },
      { p: 'note/b', data: { slug: 'x' } }, // collides with the stored document
    ])
    expect(outcome).toMatchObject({ status: 'refused', refusal: { p: 'note/b', reason: 'unique' } })
    expect(store.paths()).toEqual(['note/taken'])
  })

  test('the same unique value twice in ONE commit is refused, nothing written (M1)', async () => {
    const { store, commit } = setup()
    const outcome = await commit([
      { p: 'note/a', data: { slug: 'same' } },
      { p: 'note/b', data: { slug: 'same' } },
    ])
    expect(outcome).toMatchObject({ status: 'refused', refusal: { p: 'note/b', reason: 'unique' } })
    expect(store.paths()).toEqual([])
  })

  test('a document keeps its own unique value when rewritten', async () => {
    const { commit } = setup({}, { 'note/a': { slug: 'mine', _created: NOW } })
    expect(await commit([{ p: 'note/a', data: { slug: 'mine', body: 'v2' } }])).toMatchObject({ status: 'committed' })
  })

  test('with no method named, a missing document is created and an existing one updated', async () => {
    const { store, commit } = setup({}, { 'note/old': { slug: 'old', v: 1 } })
    const outcome = await commit([
      { p: 'note/new', data: { slug: 'new' } },
      { p: 'note/old', data: { slug: 'old', v: 2 } },
    ])
    expect(outcome).toEqual({ status: 'committed', out: [{ p: 'note/new' }, { p: 'note/old' }] })
    expect((await store.get('note/old')).data.v).toBe(2)
  })

  test('a named POST to an existing document is refused', async () => {
    const { commit } = setup({}, { 'note/a': { slug: 'a' } })
    expect(await commit([{ p: 'note/a', method: 'POST', data: { slug: 'a' } }])).toMatchObject({ status: 'refused' })
  })
})

describe('afterWrite runs AFTER the commit, like /doc', () => {
  test('each committed write gets its hook, with the document it replaced', async () => {
    const { commit, after } = setup({}, { 'note/old': { slug: 'old', v: 1 } })
    await commit([
      { p: 'note/new', data: { slug: 'new' } },
      { p: 'note/old', data: { slug: 'old', v: 2 } },
    ])
    expect(after.map(([p]) => p)).toEqual(['note/new', 'note/old'])
    expect(after[0][1]).toBeUndefined()
    expect(after[1][1]).toMatchObject({ v: 1 })
  })

  test('a refused commit runs no hook', async () => {
    const { commit, after } = setup()
    await commit([
      { p: 'note/a', data: { slug: 's' } },
      { p: 'note/b', data: { slug: 's' } },
    ])
    expect(after).toEqual([])
  })

  test('a failing hook is reported and does not undo or fail the commit', async () => {
    const { store, commit, warnings } = setup()
    expect(await commit([{ p: 'note/a', data: { slug: 's', explode: true } }])).toMatchObject({ status: 'committed' })
    expect(store.paths()).toEqual(['note/a'])
    expect(warnings).toEqual(['afterWrite failed for note/a:'])
  })
})

describe('sequenced collections (#14, #1184)', () => {
  test('a commit takes a CONTIGUOUS range from one counter', async () => {
    const { store, commit } = setup()
    expect(await commit([{ p: 'log/a', data: { e: 1 } }])).toEqual({ status: 'committed', out: [{ p: 'log/a', seq: 1 }] })
    expect(await commit([{ p: 'log/b', data: { e: 2 } }, { p: 'log/c', data: { e: 3 } }])).toEqual({
      status: 'committed',
      out: [{ p: 'log/b', seq: 2 }, { p: 'log/c', seq: 3 }],
    })
    expect((await store.get(`${SEQ_COLLECTION}/log`)).data).toEqual({ value: 3, at: NOW })
    expect((await store.get('log/c')).data._seq).toBe(3)
  })

  test('concurrent creates of ONE immutable id: exactly one commits, nothing is re-sequenced', async () => {
    const { store, commit } = setup()
    const outcomes = await Promise.all([
      commit([{ p: 'log/same', data: { e: 'first' } }]),
      commit([{ p: 'log/same', data: { e: 'second' } }]),
    ])
    expect(outcomes.map((o) => o.status).sort()).toEqual(['committed', 'refused'])
    expect((await store.get('log/same')).data).toMatchObject({ e: 'first', _seq: 1 })
    expect((await store.get(`${SEQ_COLLECTION}/log`)).data.value).toBe(1)
  })

  test('a refused sequenced commit does not advance the counter', async () => {
    const { store, commit } = setup({}, {})
    await commit([{ p: 'log/a', data: { e: 1 } }])
    await commit([{ p: 'log/a', data: { e: 'again' } }]) // immutable: refused
    expect((await store.get(`${SEQ_COLLECTION}/log`)).data.value).toBe(1)
  })
})

describe('MemoryStore transactions (what the above relies on)', () => {
  test('a read after a write is refused, as Firestore refuses it', async () => {
    const store = new MemoryStore()
    await expect(
      store.transaction(async (tx) => {
        tx.set('a/1', {})
        await tx.get('a/2')
      })
    ).rejects.toThrow('read after a write')
  })

  test('a throw discards buffered writes; a failed transaction does not block the next', async () => {
    const store = new MemoryStore()
    await expect(
      store.transaction(async (tx) => {
        tx.set('a/1', { x: 1 })
        throw new Error('no')
      })
    ).rejects.toThrow('no')
    await store.transaction(async (tx) => tx.set('a/2', { y: 1 }, { merge: true }))
    expect(store.paths()).toEqual(['a/2'])
  })

  test('merge keeps fields it does not name', async () => {
    const store = new MemoryStore({ 'a/1': { keep: true, v: 1 } })
    await store.transaction(async (tx) => tx.set('a/1', { v: 2 }, { merge: true }))
    expect((await store.get('a/1')).data).toEqual({ keep: true, v: 2 })
  })
})
