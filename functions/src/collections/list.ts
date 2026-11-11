/**
 * Listing a collection: the read half of the substrate port (#7).
 *
 * What `docs.ts` did against Firestore, against the `Store` port instead
 * (SOVEREIGN-PLAN.md Phase 1). The decisions stay here, in the kernel: which
 * `field=value` keys a list may use, filter-before-limit (D7) with its scan
 * bound, projection after filtering, and the `_seq` delta's honest `more`.
 * Only fetching pages is the adapter's.
 */

import type { Store, QueryOptions } from './store'
import { collectionPath, type CollectionMap } from './access'

/** Hard bound on how many documents a filtered list will scan (see `listRecords`). */
export const MAX_FILTER_SCAN = 2000

export interface ListTarget {
  /** Concrete collection path, e.g. `post` or `post/abc/comment`. */
  collection: string
  where: Pick<QueryOptions, 'equals' | 'arrayContains'>
}

/**
 * A `/docs` path → the concrete collection to list, and its filter.
 *
 * - `post` lists `post`;
 * - `post/tags=x` lists `post` where `tags` contains `x` (a `tagFields` key) or
 *   equals it (a `unique` key) — any other field is refused, so the path form
 *   cannot become an arbitrary query;
 * - `post/path=x/comment` resolves the parent document first.
 */
export async function resolveListPath(
  path: string,
  collections: CollectionMap,
  store: Pick<Store, 'resolve'>
): Promise<ListTarget | Error> {
  const parts = path.split('/')
  let prefix = ''
  const stack: string[] = []
  while (parts.length) {
    const collection = parts.shift() as string
    if (!collection) return new Error(`bad path ${path}`)
    stack.push(collection)
    const here = prefix ? `${prefix}/${collection}` : collection
    const spec = parts.shift()
    if (spec === undefined) return { collection: here, where: {} }

    if (!parts.length && spec.includes('=')) {
      const [field, value] = spec.split('=', 2)
      const config = collections[stack.join('/')]
      if (config?.tagFields?.includes(field)) {
        return { collection: here, where: { arrayContains: { field, value } } }
      }
      if (config?.unique?.includes(field)) {
        return { collection: here, where: { equals: { field, value } } }
      }
      return new Error(`${path} is not allowed; ${field} is not an allowed key`)
    }
    if (!parts.length) return new Error(`${path} names a document, not a collection`)

    const resolved = await store.resolve(`${here}/${spec}`)
    if (resolved instanceof Error) return resolved
    prefix = resolved
  }
  return new Error(`bad path ${path}`)
}

/** `field` / `field(asc)` / `field(desc)` → a store order; anything else is unordered (id order). */
export function listOrder(order: string): string {
  const [, field, direction] = order.match(/^(\w+)(\(asc\)|\(desc\))?$/) || []
  return field ? `${field} ${direction === '(desc)' ? 'desc' : 'asc'}` : '~'
}

/**
 * `modifiedAfter` (#4050): documents edited strictly after an ISO time, by
 * `_modified` (newest first unless `_modified(asc)`). Firestore answers a
 * range without a composite index only when the order is on the same field,
 * so ordering by anything else is refused rather than failing at query time.
 */
export function modifiedAfterQuery(
  order: string,
  value: string
): Error | { orderBy: string; greaterThan: { field: string; value: string } } {
  const time = Date.parse(value)
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || !Number.isFinite(time)) {
    return new Error('modifiedAfter must be an ISO time, e.g. 2026-11-11T08:00:00Z')
  }
  if (order && !/^_modified(\((asc|desc)\))?$/.test(order)) {
    return new Error('modifiedAfter orders by _modified; it cannot be combined with another order')
  }
  return {
    orderBy: order === '_modified(asc)' ? '_modified asc' : '_modified desc',
    // Stamped by toISOString(), so normalising makes string order time order.
    greaterThan: { field: '_modified', value: new Date(time).toISOString() },
  }
}

export interface ListOptions {
  limit: number
  order?: string
  /** Only documents edited after this ISO time (#4050); validated by the caller with modifiedAfterQuery. */
  modifiedAfter?: string
  fields?: string[] | false
  /**
   * Row-visibility filter, applied to the FULL document. Returns the record
   * (possibly narrowed) to keep it, or an Error to hide it.
   */
  filter?: (rec: Record<string, unknown>) => Promise<Error | Record<string, unknown>>
  collections: CollectionMap
  /** Told when the scan bound cut a filtered list short. */
  onScanBound?: (detail: Record<string, unknown>) => void
}

export async function listRecords(
  store: Pick<Store, 'resolve' | 'query' | 'scan'>,
  path: string,
  { limit, order = '', fields = false, filter, collections, onScanBound, modifiedAfter }: ListOptions
): Promise<Record<string, unknown>[]> {
  const target = await resolveListPath(path, collections, store)
  if (target instanceof Error) return []
  const after = modifiedAfter === undefined ? undefined : modifiedAfterQuery(order, modifiedAfter)
  // A range over a filtered path needs a composite index: refused, like a bad time.
  if (after instanceof Error || (after && Object.keys(target.where).length)) return []
  const orderBy = after ? after.orderBy : listOrder(order)
  const range = after ? { greaterThan: after.greaterThan } : {}
  // `_path` is the LOGICAL collection path plus the id, as it always was.
  const base = collectionPath(path)
  const toRecord = (doc: { path: string; data: Record<string, unknown> }) => ({
    ...doc.data,
    _path: `${base}/${doc.path.split('/').pop()}`,
  })

  // ── Unfiltered: the limit IS the answer, so let the store do it. ──────────
  if (!filter) {
    const rows = await store.query(target.collection, {
      ...target.where,
      ...range,
      orderBy,
      limit,
      ...(fields ? { fields } : {}),
    })
    return rows.map(toRecord)
  }

  // ── Filtered: FILTER BEFORE LIMIT (D7). ──────────────────────────────────
  //
  // Applying the limit first and dropping hidden rows afterwards returned 3 of
  // 10 published posts while 50 existed. Paging until we have n visible rows is
  // the right answer (Tonio, 2026-09-06: "filter before limit; insofar as that
  // is a performance problem that's for later").
  //
  // No projection pushdown here: it would strip the fields the predicate reads
  // (a `post` list projected to `title,path` has no `date`, so every row would
  // look unpublished). The filter sees the whole document; projection follows.
  const kept: Record<string, unknown>[] = []
  let scanned = 0
  const pageSize = Math.min(Math.max(limit, 50), 300)

  pages: for await (const page of store.scan(target.collection, { ...target.where, ...range, orderBy }, pageSize)) {
    scanned += page.length
    for (const doc of page) {
      const result = await filter(toRecord(doc))
      if (!(result instanceof Error)) {
        kept.push(result)
        if (kept.length === limit) break pages
      }
    }
    if (scanned >= MAX_FILTER_SCAN) break
  }

  if (kept.length < limit && scanned >= MAX_FILTER_SCAN) {
    onScanBound?.({ path, limit, returned: kept.length, scanned, bound: MAX_FILTER_SCAN })
  }

  if (!fields) return kept
  return kept.map((rec) => {
    const out: Record<string, unknown> = { _path: rec._path }
    for (const f of fields) if (f in rec) out[f] = rec[f]
    return out
  })
}

/**
 * The delta query (#14): every document with `_seq > since`, in `_seq` order.
 *
 * Ascending on `_seq` alone, so Firestore serves it from the automatic index
 * and a consumer needs no index deploy to start replicating. `more` is
 * returned, not left to inference: a server may cap `c`, so a short page does
 * NOT mean the last page (the same class of bug as D7).
 */
export async function sequencedDelta(
  store: Pick<Store, 'resolve' | 'query'>,
  path: string,
  since: number,
  limit: number,
  collections: CollectionMap
): Promise<{ rows: Record<string, unknown>[]; cursor: number; more: boolean }> {
  const target = await resolveListPath(path, collections, store)
  if (target instanceof Error) return { rows: [], cursor: since, more: false }
  // One extra row, purely to answer `more` honestly without a second query.
  const found = await store.query(target.collection, {
    ...target.where,
    greaterThan: { field: '_seq', value: since },
    orderBy: '_seq asc',
    limit: limit + 1,
  })
  const rows: Record<string, unknown>[] = found.slice(0, limit).map((d) => ({
    ...d.data,
    _id: d.path.split('/').pop() as string,
  }))
  return {
    rows,
    cursor: rows.length ? (rows[rows.length - 1]._seq as number) : since,
    more: found.length > limit,
  }
}
