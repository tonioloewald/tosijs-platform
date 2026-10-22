/**
 * Listing over the store port, by behaviour (SOVEREIGN-PLAN.md Phase 1, #7).
 *
 * `docs.ts`'s list logic used to need Firestore, so filter-before-limit was
 * tested on a COPY of its loop (filter-before-limit.test.ts). These run the
 * real `listRecords` / `sequencedDelta` against MemoryStore, whose ordering now
 * follows Firestore's (store.test.ts).
 */
import { describe, test, expect } from 'bun:test'

import { MemoryStore } from './store'
import { listRecords, listOrder, resolveListPath, sequencedDelta, MAX_FILTER_SCAN } from './list'
import type { CollectionMap } from './access'

const collections = {
  post: { unique: ['path'], tagFields: ['tags'] },
  'post/comment': { unique: ['slug'] },
} as unknown as CollectionMap

const pad = (n: number) => String(n).padStart(4, '0')
const isPub = async (r: Record<string, unknown>) =>
  r.date ? r : new Error('hidden')

/** `n` posts, every 10th published, ids in creation order. */
function corpus(n: number) {
  const seed: Record<string, Record<string, unknown>> = {}
  for (let i = 0; i < n; i++) {
    seed[`post/p${pad(i)}`] = {
      title: `Post ${i}`,
      path: `post-${i}`,
      date: i % 10 === 0 ? `2026-01-${pad(i)}` : '',
      tags: i % 2 ? ['odd'] : ['even'],
      n: i,
    }
  }
  return new MemoryStore(seed, { post: ['path', 'tags'], 'post/p0000/comment': ['slug'] })
}

describe('resolveListPath', () => {
  const store = corpus(3)
  test('a bare collection', async () => {
    expect(await resolveListPath('post', collections, store)).toEqual({ collection: 'post', where: {} })
  })
  test('a tagFields key is array-contains, a unique key is equality', async () => {
    expect(await resolveListPath('post/tags=odd', collections, store)).toEqual({
      collection: 'post', where: { arrayContains: { field: 'tags', value: 'odd' } },
    })
    expect(await resolveListPath('post/path=post-1', collections, store)).toEqual({
      collection: 'post', where: { equals: { field: 'path', value: 'post-1' } },
    })
  })
  test('any other key is refused, so the path cannot become an arbitrary query', async () => {
    expect(String(await resolveListPath('post/title=x', collections, store))).toContain('not an allowed key')
  })
  test('a parent named by field=value is resolved to its document first', async () => {
    expect(await resolveListPath('post/path=post-0/comment', collections, store)).toEqual({
      collection: 'post/p0000/comment', where: {},
    })
  })
  test('a document path is not a list', async () => {
    expect(await resolveListPath('post/p0001', collections, store)).toBeInstanceOf(Error)
  })
})

describe('listRecords', () => {
  test('unfiltered: limit, order and projection are pushed down; _path is logical', async () => {
    const rows = await listRecords(corpus(30), 'post', { limit: 3, order: 'n(desc)', fields: ['title'], collections })
    expect(rows).toEqual([
      { title: 'Post 29', _path: 'post/p0029' },
      { title: 'Post 28', _path: 'post/p0028' },
      { title: 'Post 27', _path: 'post/p0027' },
    ])
  })

  test('no order means document-id order', async () => {
    const rows = await listRecords(corpus(5), 'post', { limit: 2, collections })
    expect(rows.map((r) => r._path)).toEqual(['post/p0000', 'post/p0001'])
  })

  test('FILTER BEFORE LIMIT: 10 visible rows among 100 are all returned (D7)', async () => {
    const rows = await listRecords(corpus(100), 'post', { limit: 10, filter: isPub, collections })
    expect(rows.length).toBe(10)
    expect(rows.every((r) => r.date)).toBe(true)
  })

  test('projection happens AFTER filtering, so the predicate sees fields not asked for', async () => {
    const rows = await listRecords(corpus(30), 'post', { limit: 2, fields: ['title'], filter: isPub, collections })
    expect(rows).toEqual([
      { _path: 'post/p0000', title: 'Post 0' },
      { _path: 'post/p0010', title: 'Post 10' },
    ])
  })

  test('the filter may narrow a row it keeps', async () => {
    const rows = await listRecords(corpus(20), 'post', {
      limit: 1,
      filter: async (r) => (r.date ? { _path: r._path, title: r.title } : new Error('hidden')),
      collections,
    })
    expect(rows).toEqual([{ _path: 'post/p0000', title: 'Post 0' }])
  })

  test('a tag list filters by array-contains', async () => {
    const rows = await listRecords(corpus(6), 'post/tags=odd', { limit: 10, collections })
    expect(rows.map((r) => r.n)).toEqual([1, 3, 5])
  })

  test('the scan bound stops a selective filter and says so', async () => {
    const reports: Array<Record<string, unknown>> = []
    const rows = await listRecords(corpus(MAX_FILTER_SCAN + 500), 'post', {
      limit: 5,
      filter: async () => new Error('nothing is visible'),
      collections,
      onScanBound: (d) => reports.push(d),
    })
    expect(rows).toEqual([])
    expect(reports).toHaveLength(1)
    expect(reports[0].scanned as number).toBeGreaterThanOrEqual(MAX_FILTER_SCAN)
    expect(reports[0].scanned as number).toBeLessThan(MAX_FILTER_SCAN + 500)
  })

  test('a refused path lists nothing', async () => {
    expect(await listRecords(corpus(3), 'post/title=x', { limit: 5, collections })).toEqual([])
  })
})

describe('listOrder', () => {
  test('maps the /docs `o` parameter to a store order', () => {
    expect(listOrder('date')).toBe('date asc')
    expect(listOrder('date(asc)')).toBe('date asc')
    expect(listOrder('date(desc)')).toBe('date desc')
    expect(listOrder('')).toBe('~')
    expect(listOrder('a;drop')).toBe('~')
  })
})

describe('sequencedDelta (#14)', () => {
  const store = new MemoryStore({
    'event/a': { _seq: 1 },
    'event/b': { _seq: 2 },
    'event/c': { _seq: 3 },
    'event/d': { _seq: 10 },
    'event/x': {}, // never sequenced: not part of any delta
  })
  const events = { event: {} } as unknown as CollectionMap

  test('everything after the cursor, in sequence order, with an honest `more`', async () => {
    expect(await sequencedDelta(store, 'event', 1, 2, events)).toEqual({
      rows: [{ _seq: 2, _id: 'b' }, { _seq: 3, _id: 'c' }],
      cursor: 3,
      more: true,
    })
    expect(await sequencedDelta(store, 'event', 3, 2, events)).toEqual({
      rows: [{ _seq: 10, _id: 'd' }],
      cursor: 10,
      more: false,
    })
  })

  test('caught up: no rows, the cursor stays where it was', async () => {
    expect(await sequencedDelta(store, 'event', 10, 5, events)).toEqual({ rows: [], cursor: 10, more: false })
  })
})
