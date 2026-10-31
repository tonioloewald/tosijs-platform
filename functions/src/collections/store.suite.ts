/**
 * The Store conformance suite (SOVEREIGN-PLAN.md Phase 1).
 *
 * One set of contract tests, run against every substrate: `MemoryStore`
 * (store-conformance.test.ts, always) and the Firestore adapter against the
 * emulator (adapters/firebase/firestore-store.integration.test.ts). The SQLite
 * and Postgres adapters of later phases run it too. A substrate passes or it is
 * not a substrate; the port's promise is that the kernel cannot tell them apart.
 *
 * Every case states what FIRESTORE does, because production is the reference:
 * where MemoryStore disagreed, MemoryStore was wrong.
 *
 * Each test uses fresh collection names, so a run never collides with another
 * or with seeded data, and needs no cleanup between tests.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import {
  createDocument,
  updateDocumentIf,
  newDocId,
  type Store,
  type QueryOptions,
} from './store'

export interface StoreKeys {
  /** Fields usable as `collection/field=value` that match by equality. */
  unique?: Record<string, string[]>
  /** Fields usable as `collection/field=value` that match by array-contains. */
  tagFields?: Record<string, string[]>
}

export interface StoreHarness {
  /** A store already holding `seed` (canonical path → document). */
  make(
    seed?: Record<string, Record<string, unknown>>,
    keys?: StoreKeys
  ): Promise<Store>
}

/** A collection name no other test (or run) uses. */
const fresh = (name: string) =>
  `${name}-${newDocId().slice(0, 8).toLowerCase()}`

export function storeConformance(
  substrate: string,
  harness: StoreHarness,
  timeout = 5000
): void {
  const ids = async (store: Store, collection: string, options: QueryOptions) =>
    (await store.query(collection, options)).map((d) =>
      d.path.slice(collection.length + 1)
    )

  describe(`Store conformance: ${substrate}`, () => {
    describe('get / set / delete', () => {
      test(
        'a missing document is exists:false with empty data, never a throw',
        async () => {
          const c = fresh('doc')
          const store = await harness.make()
          expect(await store.get(`${c}/nope`)).toEqual({
            path: `${c}/nope`,
            exists: false,
            data: {},
          })
        },
        timeout
      )

      test(
        'every JSON value round-trips',
        async () => {
          const c = fresh('doc')
          const store = await harness.make()
          const data = {
            s: 'text',
            i: 3,
            f: 1.5,
            neg: -2,
            t: true,
            n: null,
            a: [1, 'two', { three: 3 }],
            m: { nested: { deep: ['x'] } },
            empty: {},
            none: [],
          }
          await store.set(`${c}/a`, data)
          expect((await store.get(`${c}/a`)).data).toEqual(data)
        },
        timeout
      )

      test(
        'an EMPTY document exists',
        async () => {
          const c = fresh('doc')
          const store = await harness.make({ [`${c}/e`]: {} })
          expect(await store.get(`${c}/e`)).toEqual({
            path: `${c}/e`,
            exists: true,
            data: {},
          })
        },
        timeout
      )

      test(
        'set replaces the whole document',
        async () => {
          const c = fresh('doc')
          const store = await harness.make({ [`${c}/a`]: { keep: 1, drop: 2 } })
          await store.set(`${c}/a`, { keep: 3 })
          expect((await store.get(`${c}/a`)).data).toEqual({ keep: 3 })
        },
        timeout
      )

      test(
        'delete removes; deleting a missing document is not an error',
        async () => {
          const c = fresh('doc')
          const store = await harness.make({ [`${c}/a`]: { x: 1 } })
          await store.delete(`${c}/a`)
          await store.delete(`${c}/never`)
          expect((await store.get(`${c}/a`)).exists).toBe(false)
        },
        timeout
      )

      test(
        'returned data is a copy: mutating it does not change the store',
        async () => {
          const c = fresh('doc')
          const store = await harness.make({ [`${c}/a`]: { tags: ['x'] } })
          const first = await store.get(`${c}/a`)
          ;(first.data.tags as string[]).push('injected')
          expect((await store.get(`${c}/a`)).data.tags).toEqual(['x'])
        },
        timeout
      )

      test(
        'sub-collection documents are addressed by their full path',
        async () => {
          const c = fresh('doc')
          const store = await harness.make({
            [`${c}/p/comment/c1`]: { body: 'hi' },
          })
          expect((await store.get(`${c}/p/comment/c1`)).data).toEqual({
            body: 'hi',
          })
          expect((await store.get(`${c}/p`)).exists).toBe(false)
        },
        timeout
      )
    })

    describe('resolve', () => {
      test(
        'collection/id is already canonical',
        async () => {
          const c = fresh('post')
          const store = await harness.make()
          expect(await store.resolve(`${c}/xyz`)).toBe(`${c}/xyz`)
          expect(await store.resolve(`${c}/p/comment/c1`)).toBe(
            `${c}/p/comment/c1`
          )
        },
        timeout
      )

      test(
        'field=value finds the document by a unique field',
        async () => {
          const c = fresh('post')
          const store = await harness.make(
            { [`${c}/xyz`]: { path: 'hello-world' } },
            { unique: { [c]: ['path'] } }
          )
          expect(await store.resolve(`${c}/path=hello-world`)).toBe(`${c}/xyz`)
        },
        timeout
      )

      test(
        'field=value finds the document by a tag field (array-contains)',
        async () => {
          const c = fresh('page')
          const store = await harness.make(
            { [`${c}/p1`]: { tags: ['a', 'home'] } },
            { tagFields: { [c]: ['tags'] } }
          )
          expect(await store.resolve(`${c}/tags=home`)).toBe(`${c}/p1`)
        },
        timeout
      )

      test(
        'the value is a STRING: it does not match a stored number',
        async () => {
          // Firestore compares `'5' == 5` as false. MemoryStore used String(held)
          // and matched, so a path that 404s in production resolved in tests.
          const c = fresh('post')
          const store = await harness.make(
            { [`${c}/n`]: { num: 5 } },
            { unique: { [c]: ['num'] } }
          )
          expect(await store.resolve(`${c}/num=5`)).toBeInstanceOf(Error)
        },
        timeout
      )

      test(
        'a field that is not a key is refused',
        async () => {
          const c = fresh('post')
          const store = await harness.make(
            { [`${c}/xyz`]: { secret: 's' } },
            { unique: { [c]: ['path'] } }
          )
          const r = await store.resolve(`${c}/secret=s`)
          expect(r).toBeInstanceOf(Error)
          expect(String(r)).toContain('not an allowed key')
        },
        timeout
      )

      test(
        'no match, or an odd-length path, is an Error',
        async () => {
          const c = fresh('post')
          const store = await harness.make({}, { unique: { [c]: ['path'] } })
          expect(await store.resolve(`${c}/path=missing`)).toBeInstanceOf(Error)
          expect(await store.resolve(c)).toBeInstanceOf(Error)
          expect(await store.resolve(`${c}/a/b`)).toBeInstanceOf(Error)
        },
        timeout
      )
    })

    describe('isUnique', () => {
      test(
        'free, taken by another, and taken by the document itself',
        async () => {
          const c = fresh('post')
          const store = await harness.make(
            { [`${c}/a`]: { path: 'x' } },
            { unique: { [c]: ['path'] } }
          )
          expect(await store.isUnique(c, 'path', 'y', `${c}/b`)).toBe(true)
          expect(await store.isUnique(c, 'path', 'x', `${c}/b`)).toBe(false)
          // Self-exclusion, or every re-save collides with itself (review F12).
          expect(await store.isUnique(c, 'path', 'x', `${c}/a`)).toBe(true)
        },
        timeout
      )

      test(
        'only the same collection counts',
        async () => {
          const c = fresh('post')
          const other = fresh('page')
          const store = await harness.make(
            { [`${other}/a`]: { path: 'x' } },
            { unique: { [c]: ['path'] } }
          )
          expect(await store.isUnique(c, 'path', 'x', `${c}/b`)).toBe(true)
        },
        timeout
      )

      test(
        'a non-scalar or absent value never satisfies the constraint',
        async () => {
          const c = fresh('post')
          const store = await harness.make({}, { unique: { [c]: ['path'] } })
          expect(await store.isUnique(c, 'path', undefined, `${c}/a`)).toBe(
            false
          )
          expect(await store.isUnique(c, 'path', { a: 1 }, `${c}/a`)).toBe(
            false
          )
          expect(await store.isUnique(c, 'path', 7, `${c}/a`)).toBe(true)
        },
        timeout
      )
    })

    describe('query', () => {
      test(
        'the default order is _created desc, and excludes documents without it',
        async () => {
          const c = fresh('n')
          const store = await harness.make({
            [`${c}/a`]: { _created: '2026-01-01' },
            [`${c}/b`]: { _created: '2026-03-01' },
            [`${c}/c`]: { x: 1 },
          })
          expect(await ids(store, c, {})).toEqual(['b', 'a'])
        },
        timeout
      )

      test(
        'numbers numerically, ties by document id, missing fields excluded, ~ is id order',
        async () => {
          const c = fresh('n')
          const store = await harness.make({
            [`${c}/b`]: { k: 10 },
            [`${c}/a`]: { k: 9 },
            [`${c}/c`]: { k: 10 },
            [`${c}/d`]: {},
            [`${c}/e`]: { k: 9.5 },
          })
          expect(await ids(store, c, { orderBy: 'k asc' })).toEqual([
            'a',
            'e',
            'b',
            'c',
          ])
          expect(await ids(store, c, { orderBy: 'k desc' })).toEqual([
            'c',
            'b',
            'e',
            'a',
          ])
          expect(await ids(store, c, { orderBy: '~' })).toEqual([
            'a',
            'b',
            'c',
            'd',
            'e',
          ])
        },
        timeout
      )

      test(
        'across types: null < boolean < number < string < array < map',
        async () => {
          const c = fresh('n')
          const store = await harness.make({
            [`${c}/map`]: { k: { a: 1 } },
            [`${c}/arr`]: { k: [1] },
            [`${c}/str`]: { k: 'a' },
            [`${c}/num`]: { k: 1 },
            [`${c}/bool`]: { k: true },
            [`${c}/nul`]: { k: null },
          })
          expect(await ids(store, c, { orderBy: 'k asc' })).toEqual([
            'nul',
            'bool',
            'num',
            'str',
            'arr',
            'map',
          ])
        },
        timeout
      )

      test(
        'strings by UTF-8 bytes, not locale and not UTF-16 code units',
        async () => {
          // U+FFFD is one UTF-16 unit above the surrogate that starts an emoji, but
          // below it in UTF-8: code-unit order puts the emoji first, Firestore last.
          const c = fresh('n')
          const store = await harness.make({
            [`${c}/emoji`]: { k: '\u{1F600}' },
            [`${c}/fffd`]: { k: '�' },
            [`${c}/lower`]: { k: 'a' },
            [`${c}/upper`]: { k: 'Z' },
            [`${c}/accent`]: { k: 'é' },
          })
          expect(await ids(store, c, { orderBy: 'k asc' })).toEqual([
            'upper',
            'lower',
            'accent',
            'fffd',
            'emoji',
          ])
        },
        timeout
      )

      test(
        'equals and arrayContains compare maps by content, ignoring key order',
        async () => {
          const c = fresh('role')
          const store = await harness.make({
            [`${c}/r`]: {
              contacts: [{ type: 'email', value: 'a@example.invalid' }],
              meta: { a: 1, b: [2] },
            },
            [`${c}/s`]: {
              contacts: [{ type: 'email', value: 'b@example.invalid' }],
              meta: { a: 1 },
            },
          })
          expect(
            await ids(store, c, {
              orderBy: '~',
              arrayContains: {
                field: 'contacts',
                value: { value: 'a@example.invalid', type: 'email' },
              },
            })
          ).toEqual(['r'])
          expect(
            await ids(store, c, {
              orderBy: '~',
              arrayContains: { field: 'contacts', value: { type: 'email' } },
            })
          ).toEqual([])
          expect(
            await ids(store, c, {
              orderBy: '~',
              equals: { field: 'meta', value: { b: [2], a: 1 } },
            })
          ).toEqual(['r'])
        },
        timeout
      )

      test(
        'equals on a scalar, with an order on another field',
        async () => {
          const c = fresh('token')
          const store = await harness.make({
            [`${c}/a`]: { hash: 'h', _created: '1' },
            [`${c}/b`]: { hash: 'h', _created: '2' },
            [`${c}/c`]: { hash: 'other', _created: '3' },
          })
          expect(
            await ids(store, c, { equals: { field: 'hash', value: 'h' } })
          ).toEqual(['b', 'a'])
        },
        timeout
      )

      test(
        'greaterThan and lessThan match the same type only',
        async () => {
          const c = fresh('n')
          const store = await harness.make({
            [`${c}/a`]: { k: 9 },
            [`${c}/b`]: { k: 10 },
            [`${c}/e`]: { k: 'Z' },
            [`${c}/f`]: { k: 'a' },
          })
          expect(
            await ids(store, c, {
              orderBy: 'k asc',
              greaterThan: { field: 'k', value: 9 },
            })
          ).toEqual(['b'])
          expect(
            await ids(store, c, {
              orderBy: 'k asc',
              lessThan: { field: 'k', value: 10 },
            })
          ).toEqual(['a'])
          expect(
            await ids(store, c, {
              orderBy: 'k asc',
              lessThan: { field: 'k', value: 'a' },
            })
          ).toEqual(['e'])
        },
        timeout
      )

      test(
        'oneOf matches any listed value',
        async () => {
          const c = fresh('n')
          const store = await harness.make({
            [`${c}/a`]: { k: 9 },
            [`${c}/b`]: { k: 10 },
            [`${c}/e`]: { k: 'Z' },
          })
          expect(
            await ids(store, c, {
              orderBy: '~',
              oneOf: { field: 'k', values: [9, 'Z', 'missing'] },
            })
          ).toEqual(['a', 'e'])
        },
        timeout
      )

      test(
        'limit, and fields projects without dropping documents',
        async () => {
          const c = fresh('n')
          const store = await harness.make({
            [`${c}/a`]: { k: 1, x: 'drop' },
            [`${c}/b`]: { k: 2 },
            [`${c}/c`]: { x: 'no k' },
          })
          const rows = await store.query(c, {
            orderBy: '~',
            fields: ['k'],
            limit: 2,
          })
          expect(rows).toEqual([
            { path: `${c}/a`, exists: true, data: { k: 1 } },
            { path: `${c}/b`, exists: true, data: { k: 2 } },
          ])
          // A document lacking every selected field is still returned, empty.
          expect(
            (await store.query(c, { orderBy: '~', fields: ['k'] }))[2]
          ).toEqual({ path: `${c}/c`, exists: true, data: {} })
        },
        timeout
      )

      test(
        'an empty or missing collection is an empty list',
        async () => {
          const store = await harness.make()
          expect(await store.query(fresh('none'), { orderBy: '~' })).toEqual([])
        },
        timeout
      )
    })

    describe('scan', () => {
      test(
        'pages through the query in order, with no trailing empty page',
        async () => {
          const c = fresh('n')
          const seed: Record<string, Record<string, unknown>> = {}
          for (const id of ['a', 'b', 'c', 'd']) seed[`${c}/${id}`] = { k: id }
          const store = await harness.make(seed)
          const pages = async (pageSize: number) => {
            const out: string[][] = []
            for await (const page of store.scan(
              c,
              { orderBy: 'k desc' },
              pageSize
            )) {
              out.push(page.map((d) => d.path.slice(c.length + 1)))
            }
            return out
          }
          expect(await pages(3)).toEqual([['d', 'c', 'b'], ['a']])
          expect(await pages(2)).toEqual([
            ['d', 'c'],
            ['b', 'a'],
          ])
        },
        timeout
      )

      test(
        'the consumer may stop early',
        async () => {
          const c = fresh('n')
          const store = await harness.make({
            [`${c}/a`]: {},
            [`${c}/b`]: {},
            [`${c}/c`]: {},
          })
          const seen: string[] = []
          for await (const page of store.scan(c, { orderBy: '~' }, 1)) {
            seen.push(page[0].path)
            break
          }
          expect(seen).toEqual([`${c}/a`])
        },
        timeout
      )
    })

    describe('transaction', () => {
      test(
        'writes land together and the body’s result is returned',
        async () => {
          const c = fresh('tx')
          const store = await harness.make({ [`${c}/counter`]: { n: 1 } })
          const result = await store.transaction(async (tx) => {
            const { data } = await tx.get(`${c}/counter`)
            const rows = await tx.query(c, { orderBy: '~' })
            tx.set(`${c}/counter`, { n: (data.n as number) + 1 })
            tx.set(`${c}/log`, { rows: rows.length })
            return 'done'
          })
          expect(result).toBe('done')
          expect((await store.get(`${c}/counter`)).data).toEqual({ n: 2 })
          expect((await store.get(`${c}/log`)).data).toEqual({ rows: 1 })
        },
        timeout
      )

      test(
        'a throw discards every write',
        async () => {
          const c = fresh('tx')
          const store = await harness.make({ [`${c}/a`]: { n: 1 } })
          const run = store.transaction(async (tx) => {
            tx.set(`${c}/a`, { n: 2 })
            tx.set(`${c}/b`, { n: 2 })
            throw new Error('abandon')
          })
          await expect(run).rejects.toThrow('abandon')
          expect((await store.get(`${c}/a`)).data).toEqual({ n: 1 })
          expect((await store.get(`${c}/b`)).exists).toBe(false)
        },
        timeout
      )

      test(
        'a read after a write is refused',
        async () => {
          const c = fresh('tx')
          const store = await harness.make()
          const run = store.transaction(async (tx) => {
            tx.set(`${c}/a`, { n: 1 })
            await tx.get(`${c}/b`)
          })
          await expect(run).rejects.toThrow()
          expect((await store.get(`${c}/a`)).exists).toBe(false)
        },
        timeout
      )

      test(
        'merge replaces named top-level fields WHOLE and keeps the rest',
        async () => {
          const c = fresh('tx')
          const store = await harness.make({
            [`${c}/a`]: { keep: 1, map: { old: 1, other: 2 } },
          })
          await store.transaction(async (tx) => {
            tx.set(
              `${c}/a`,
              { map: { new: 1 }, 'dotted.key': true },
              { merge: true }
            )
          })
          expect((await store.get(`${c}/a`)).data).toEqual({
            keep: 1,
            map: { new: 1 },
            'dotted.key': true,
          })
        },
        timeout
      )

      test(
        'merge onto a missing document creates it',
        async () => {
          const c = fresh('tx')
          const store = await harness.make()
          await store.transaction(async (tx) => {
            tx.set(`${c}/a`, { x: 1 }, { merge: true })
          })
          expect((await store.get(`${c}/a`)).data).toEqual({ x: 1 })
        },
        timeout
      )

      test(
        'createDocument never overwrites, even when two race for one id (#1184)',
        async () => {
          const c = fresh('tx')
          const store = await harness.make({
            [`${c}/taken`]: { owner: 'first' },
          })
          await expect(
            createDocument(store, `${c}/taken`, { owner: 'second' })
          ).rejects.toThrow('already exists')
          const results = await Promise.allSettled([
            createDocument(store, `${c}/race`, { owner: 'a' }),
            createDocument(store, `${c}/race`, { owner: 'b' }),
          ])
          expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
          const winner = results.findIndex((r) => r.status === 'fulfilled')
          expect((await store.get(`${c}/race`)).data).toEqual({
            owner: winner === 0 ? 'a' : 'b',
          })
        },
        timeout
      )

      test(
        'updateDocumentIf checks and sets once, and never creates',
        async () => {
          const c = fresh('tx')
          const store = await harness.make({
            [`${c}/grant`]: { state: 'pending', who: 'x' },
          })
          const approve = () =>
            updateDocumentIf(
              store,
              `${c}/grant`,
              (d) => d?.state === 'pending',
              { state: 'approved' }
            )
          const results = await Promise.all([approve(), approve()])
          expect(results.sort()).toEqual([false, true])
          expect((await store.get(`${c}/grant`)).data).toEqual({
            state: 'approved',
            who: 'x',
          })
          expect(
            await updateDocumentIf(store, `${c}/missing`, () => true, { x: 1 })
          ).toBe(false)
          expect((await store.get(`${c}/missing`)).exists).toBe(false)
        },
        timeout
      )
    })
  })
}
