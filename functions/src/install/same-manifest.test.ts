/**
 * A published version always means the same thing (#5).
 *
 * Re-submitting a manifest version is NORMAL — approving a parked upgrade is
 * literally POSTing the same manifest again with `approving` set. So the rule
 * cannot be "send a version once"; it has to be "a version's content never
 * changes". `sameManifest` is what tells those two apart.
 *
 * The case it exists for: a library is reviewed at 1.2.0, parked pending
 * approval, and 1.2.0's collections or access rules are swapped before the
 * human clicks approve — so what takes effect is not what was read.
 * `approving` pins the capabilities; this pins everything else.
 *
 * Run: cd functions && bun test src/install/same-manifest.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import { sameManifest } from './manifest-identity'

const stored = {
  manifest: 1,
  name: 'virta',
  version: '1.2.0',
  collections: { 'virta:task': { schema: { type: 'object' }, access: [] } },
  installedBy: 'u1',
  installedAt: '2026-09-19T00:00:00.000Z',
}

describe('the same manifest is recognised as the same', () => {
  test('identical content matches', () => {
    expect(sameManifest(stored, { ...stored })).toBe(true)
  })

  test('key ORDER does not matter', () => {
    // It comes back from Firestore in whatever order Firestore likes, so an
    // order-sensitive comparison would refuse every legitimate approval.
    const reordered = {
      version: '1.2.0',
      collections: stored.collections,
      name: 'virta',
      manifest: 1,
    }
    expect(sameManifest(stored, reordered)).toBe(true)
  })

  test('nested key order does not matter either', () => {
    const a = { c: { x: 1, y: 2 }, list: [{ p: 1, q: 2 }] }
    const b = { list: [{ q: 2, p: 1 }], c: { y: 2, x: 1 } }
    expect(sameManifest(a, b)).toBe(true)
  })

  test('provenance is ignored — a second install is a different moment', () => {
    expect(
      sameManifest(stored, {
        ...stored,
        installedBy: 'someone-else',
        installedAt: '2027-01-01T00:00:00.000Z',
      })
    ).toBe(true)
  })
})

describe('a changed version is recognised as changed', () => {
  test('a different collection', () => {
    expect(
      sameManifest(stored, {
        ...stored,
        collections: {
          ...stored.collections,
          'virta:secret': { schema: {}, access: [] },
        },
      })
    ).toBe(false)
  })

  test('a changed access rule, however deep', () => {
    expect(
      sameManifest(stored, {
        ...stored,
        collections: {
          'virta:task': {
            schema: { type: 'object' },
            access: [{ role: 'public', write: 'ALL' }],
          },
        },
      })
    ).toBe(false)
  })

  test('ARRAY ORDER still matters — it is meaningful', () => {
    // Unlike keys: `required: ['a','b']` and access lists are sequences.
    expect(sameManifest({ r: ['a', 'b'] }, { r: ['b', 'a'] })).toBe(false)
  })

  test('an added field', () => {
    expect(sameManifest(stored, { ...stored, capabilities: [] })).toBe(false)
  })

  test('a removed field', () => {
    const { collections, ...withoutCollections } = stored
    expect(collections).toBeDefined()
    expect(sameManifest(stored, withoutCollections)).toBe(false)
  })

  test('undefined and absent are the same, null is not', () => {
    // Firestore never stores `undefined`, so a field the caller sent as
    // undefined comes back absent; treating those as different would refuse
    // approvals for no reason. `null` is a real stored value.
    expect(sameManifest({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(sameManifest({ a: 1, b: null }, { a: 1 })).toBe(false)
  })
})
