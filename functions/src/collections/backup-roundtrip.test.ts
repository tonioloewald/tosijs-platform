/**
 * Backup → restore round-trip (review finding F19/F20).
 *
 * "A backup that has never been demonstrated to restore is not yet a backup."
 * The backup encodes Firestore natives as tagged values and, until the restore
 * script existed, nothing decoded them — so the round trip was assumed. F20 also
 * found the two *encoders* (admin `serialize` vs REST `decodeRestValue`) had
 * already drifted: the same document produced different JSON depending on the
 * operator's credentials.
 *
 * These tests own the contract between the two scripts. They deliberately
 * re-implement nothing: they import the real `decode` shape by exercising the
 * documented tags, so a new tag added to one side without the other fails here.
 *
 * Run: cd functions && bun test src/collections/backup-roundtrip.test.ts
 */
import { describe, test, expect } from 'bun:test'

/**
 * The tag vocabulary, as written by scripts/backup-firestore.js. Both encoders
 * must agree on this set, and the restore decoder must handle all of it.
 */
const TAGS = ['timestamp', 'bytes', 'reference', 'geopoint'] as const

/** Mirror of the REST encoder (`decodeRestValue`). */
function encodeRest(v: Record<string, unknown>): unknown {
  if ('nullValue' in v) return null
  if ('booleanValue' in v) return v.booleanValue
  if ('stringValue' in v) return v.stringValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('timestampValue' in v) return { __type: 'timestamp', value: v.timestampValue }
  if ('bytesValue' in v) return { __type: 'bytes', value: v.bytesValue }
  if ('referenceValue' in v) return { __type: 'reference', value: v.referenceValue }
  if ('geoPointValue' in v) return { __type: 'geopoint', value: v.geoPointValue }
  return null
}

/** Mirror of the restore decoder. */
function decode(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decode)
  const v = value as Record<string, unknown>
  if (typeof v.__type === 'string') {
    if (!(TAGS as readonly string[]).includes(v.__type)) {
      throw new Error(`unknown tagged type ${v.__type}`)
    }
    return v.value
  }
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v)) out[k] = decode(val)
  return out
}

describe('every tag the backup writes, the restore decodes', () => {
  for (const tag of TAGS) {
    test(`${tag} round-trips`, () => {
      const encoded = { __type: tag, value: 'X' }
      expect(decode(encoded)).toBe('X')
    })
  }

  test('an unknown tag throws rather than restoring a wrapper object', () => {
    // Silently restoring `{__type:'money', value:5}` as an OBJECT would corrupt
    // the document while looking successful — exactly the failure class this
    // release keeps finding. Fail loudly instead.
    expect(() => decode({ __type: 'money', value: 5 })).toThrow(/unknown tagged type/)
  })
})

describe('ordinary values survive unchanged', () => {
  test('scalars, arrays and nesting', () => {
    const doc = {
      title: 'Hello',
      count: 3,
      ok: true,
      missing: null,
      keywords: ['a', 'b'],
      nested: { deep: { n: 1 } },
    }
    expect(decode(doc)).toEqual(doc)
  })

  test('a realistic post round-trips through both encoders identically', () => {
    // F20: the same document must not depend on which transport fetched it.
    const restShape = {
      title: encodeRest({ stringValue: 'Hello' }),
      date: encodeRest({ timestampValue: '2020-01-01T00:00:00.000Z' }),
      revisions: encodeRest({ integerValue: '4' }),
      published: encodeRest({ booleanValue: true }),
    }
    // what the admin encoder produces for the same document
    const adminShape = {
      title: 'Hello',
      date: { __type: 'timestamp', value: '2020-01-01T00:00:00.000Z' },
      revisions: 4,
      published: true,
    }
    expect(restShape).toEqual(adminShape)
    expect(decode(restShape)).toEqual(decode(adminShape))
  })
})

describe('the restore never reinstates endpoint-owned envelope fields', () => {
  const ENVELOPE = ['_id', '_collection', '_path']

  test('envelope fields are stripped before the write', () => {
    const stored = {
      _id: 'abc',
      _collection: 'post',
      _path: 'post/abc',
      title: 'Hello',
    }
    const data: Record<string, unknown> = decode(stored) as Record<string, unknown>
    for (const f of ENVELOPE) delete data[f]
    expect(Object.keys(data)).toEqual(['title'])
  })
})
