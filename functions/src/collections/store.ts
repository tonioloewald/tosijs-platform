/**
 * The substrate port (tosijs-platform#7).
 *
 * Everything the endpoint needs from a document store, and nothing more. The
 * point is that `/doc` and the write pipeline talk to THIS, never to Firestore,
 * so a manifest can declare *logical* collections and the adapter decides where
 * they live — Firestore today, Postgres tomorrow, an in-memory map in a test.
 *
 * ## Derived, not invented
 *
 * These five operations are what `doc.ts` actually did against Firestore:
 * resolve a path (including the `field=value` form), read a document, write
 * one, delete one, and check a uniqueness constraint while excluding the
 * document being written. `query` is declared here for `docs.ts` but is not yet
 * wired — see the note on it.
 *
 * ## Canonical paths
 *
 * `resolve()` turns a request path into a canonical `collection/id`, so every
 * other method takes something unambiguous. This matters for the `field=value`
 * form (`post/path=hello-world`), which costs a query to resolve: resolving
 * once and reusing the canonical path keeps the round-trip count identical to
 * the pre-port code rather than quietly doubling it.
 *
 * ## Purity
 *
 * This module imports nothing from firebase. `MemoryStore` below is a complete
 * second substrate, which is what makes "the same code path works against two
 * stores" a real test instead of a promise — and what lets most integration
 * coverage stop needing emulators.
 */

/** A document as the store sees it. `exists` is authoritative, not inferred. */
export interface StoredDoc {
  path: string
  exists: boolean
  data: Record<string, unknown>
}

export interface QueryOptions {
  /** Max rows to return. */
  limit?: number
  /**
   * `field desc` / `field asc`, default `_created desc`; `~` means "no explicit
   * order", which is document-id order. Ordering by a field EXCLUDES documents
   * that lack it, and ties fall back to document id — both as Firestore does.
   */
  orderBy?: string
  /** Restrict to documents whose `field` array contains `value`. */
  arrayContains?: { field: string; value: unknown }
  /** Restrict to documents where `field` equals `value`. */
  equals?: { field: string; value: unknown }
  /** Restrict to documents whose `field` is strictly greater (the `_seq` cursor). */
  greaterThan?: { field: string; value: number | string }
  /**
   * Return only these fields. A pushdown, so a caller that must FILTER on other
   * fields fetches whole documents and projects afterwards (D7, docs.ts).
   */
  fields?: string[]
}

export interface Store {
  /**
   * Turn a request path into a canonical `collection/id`.
   *
   * Handles `collection/id` directly and `collection/field=value` by lookup.
   * Returns an Error when the path is malformed, the field is not an allowed
   * key, or no document matches — the endpoint maps that to a 404.
   */
  resolve(path: string): Promise<string | Error>

  /** Read one document by canonical path. Never throws for "missing". */
  get(path: string): Promise<StoredDoc>

  /** Create or replace one document by canonical path. */
  set(path: string, data: Record<string, unknown>): Promise<void>

  /** Remove one document by canonical path. */
  delete(path: string): Promise<void>

  /**
   * Is `value` free for `field` in `collection`, ignoring `excludingPath`?
   *
   * The exclusion is what lets a document keep its own unique value across an
   * update; an implementation that drops it fails every re-save (review F12).
   */
  isUnique(
    collection: string,
    field: string,
    value: unknown,
    excludingPath: string
  ): Promise<boolean>

  /**
   * List documents in a collection.
   *
   * Wired for the principal resolver (`principal.ts`, 2026-10-22); `docs.ts`
   * still queries Firestore directly, and wiring it is the remaining half of
   * #7. The read path's filter-before-limit behaviour (D7) constrains the
   * shape: the store returns rows, the endpoint filters them, so for an
   * access-filtered list `limit` is applied by the CALLER after filtering, not
   * pushed down. `equals` and `arrayContains` compare objects by content, as
   * Firestore does.
   */
  query(collection: string, options?: QueryOptions): Promise<StoredDoc[]>

  /**
   * The same query, in pages of `pageSize`, until the collection is exhausted
   * or the consumer stops. Paging is the adapter's business (Firestore
   * `startAfter`, SQL keyset); deciding how many pages to read — the
   * filter-before-limit loop and its scan bound (D7) — is the caller's.
   */
  scan(
    collection: string,
    options: Omit<QueryOptions, 'limit'>,
    pageSize: number
  ): AsyncIterable<StoredDoc[]>
}

/**
 * Equality as Firestore's `==` and `array-contains` define it: objects by
 * CONTENT, regardless of key order. `===` compared them by reference, so an
 * array-contains on an object (the role lookup by `{type, value}` contact)
 * could never match in MemoryStore while matching in production — the kind of
 * substrate drift the conformance suite exists to catch.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  return (
    ka.length === kb.length &&
    ka.every((k) =>
      sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
  )
}

/**
 * Firestore's cross-type order, as far as JSON values go: null < boolean <
 * number < string < array < object. Within a type, numbers numerically and
 * strings by code unit (Firestore compares UTF-8 bytes, NOT locale order).
 */
function compareValues(a: unknown, b: unknown): number {
  const rank = (v: unknown) =>
    v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2
      : typeof v === 'string' ? 3 : Array.isArray(v) ? 4 : 5
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  if (ra === 2 || ra === 1) return Number(a) - Number(b)
  if (ra === 3) return a === b ? 0 : (a as string) < (b as string) ? -1 : 1
  return 0
}

const clone = <T>(v: T): T =>
  v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)

/**
 * A complete in-memory substrate.
 *
 * Not a stub: it implements the same contract as the Firestore adapter,
 * including `field=value` resolution and self-excluding uniqueness. That is the
 * point — it is the second substrate that makes the port's central claim
 * ("a manifest installs identically against two stores") testable today.
 *
 * Documents are deep-cloned in and out so a test cannot accidentally mutate
 * stored state through a returned reference, which is a failure mode a real
 * store does not have and a naive fake does.
 */
export class MemoryStore implements Store {
  private docs = new Map<string, Record<string, unknown>>()

  constructor(
    seed: Record<string, Record<string, unknown>> = {},
    /**
     * Which fields may be used in the `field=value` path form, per collection.
     * Firestore's adapter derives this from the collection config's `unique` and
     * `tagFields`; here it is injected so the fake needs no config machinery.
     */
    private readonly keyFields: Record<string, string[]> = {}
  ) {
    for (const [path, data] of Object.entries(seed)) {
      this.docs.set(path, clone(data))
    }
  }

  private static split(path: string): { collection: string; id: string } {
    const parts = path.split('/')
    const id = parts.pop() as string
    return { collection: parts.join('/'), id }
  }

  async resolve(path: string): Promise<string | Error> {
    const parts = path.split('/')
    if (parts.length % 2 !== 0) return new Error(`bad path ${path}`)
    const { collection, id } = MemoryStore.split(path)
    if (!id.includes('=')) return path
    const [field, value] = id.split('=', 2)
    if (!(this.keyFields[collection] ?? []).includes(field)) {
      return new Error(`${path} is not allowed; ${field} is not an allowed key`)
    }
    for (const [p, data] of this.docs) {
      if (MemoryStore.split(p).collection !== collection) continue
      const held = data[field]
      if (Array.isArray(held) ? held.includes(value) : String(held) === value) {
        return p
      }
    }
    return new Error(`record not found ${path}`)
  }

  async get(path: string): Promise<StoredDoc> {
    const data = this.docs.get(path)
    return {
      path,
      exists: data !== undefined,
      data: data === undefined ? {} : clone(data),
    }
  }

  async set(path: string, data: Record<string, unknown>): Promise<void> {
    this.docs.set(path, clone(data))
  }

  async delete(path: string): Promise<void> {
    this.docs.delete(path)
  }

  async isUnique(
    collection: string,
    field: string,
    value: unknown,
    excludingPath: string
  ): Promise<boolean> {
    // Matches the Firestore adapter: a non-scalar (or absent) value can never
    // satisfy a unique constraint, so it is refused rather than ignored.
    if (!['string', 'number'].includes(typeof value)) return false
    for (const [p, data] of this.docs) {
      if (p === excludingPath) continue
      if (MemoryStore.split(p).collection !== collection) continue
      if (data[field] === value) return false
    }
    return true
  }

  async query(
    collection: string,
    options: QueryOptions = {}
  ): Promise<StoredDoc[]> {
    let rows = [...this.docs.entries()]
      .filter(([p]) => MemoryStore.split(p).collection === collection)
      .map(([path, data]) => ({ path, exists: true, data: clone(data) }))

    if (options.equals) {
      const { field, value } = options.equals
      rows = rows.filter((r) => sameValue(r.data[field], value))
    }
    if (options.arrayContains) {
      const { field, value } = options.arrayContains
      rows = rows.filter((r) => {
        const held = r.data[field]
        return Array.isArray(held) && held.some((h) => sameValue(h, value))
      })
    }
    if (options.greaterThan) {
      const { field, value } = options.greaterThan
      rows = rows.filter(
        (r) =>
          typeof r.data[field] === typeof value &&
          compareValues(r.data[field], value) > 0
      )
    }

    const byId = (a: StoredDoc, b: StoredDoc) => compareValues(a.path, b.path)
    const order = options.orderBy ?? '_created desc'
    const [field, direction] = order.split(' ')
    if (field === '~') {
      rows.sort(byId)
    } else {
      const sign = direction === 'desc' ? -1 : 1
      rows = rows.filter((r) => r.data[field] !== undefined)
      rows.sort(
        (a, b) =>
          sign * (compareValues(a.data[field], b.data[field]) || byId(a, b))
      )
    }

    if (options.limit) rows = rows.slice(0, options.limit)
    if (options.fields) {
      const keep = options.fields
      rows = rows.map((r) => ({
        ...r,
        data: Object.fromEntries(
          keep.filter((f) => f in r.data).map((f) => [f, r.data[f]])
        ),
      }))
    }
    return rows
  }

  async* scan(
    collection: string,
    options: Omit<QueryOptions, 'limit'>,
    pageSize: number
  ): AsyncIterable<StoredDoc[]> {
    const all = await this.query(collection, options)
    for (let i = 0; i < all.length; i += pageSize) {
      yield all.slice(i, i + pageSize)
    }
  }

  /** Test affordance: every stored path, for assertions. */
  paths(): string[] {
    return [...this.docs.keys()].sort()
  }
}
