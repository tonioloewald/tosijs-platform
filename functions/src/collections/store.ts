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
  /** Max rows to return AFTER any caller-side filtering. */
  limit?: number
  /** `field desc` / `field asc`; `~` means "do not order". */
  orderBy?: string
  /** Restrict to documents whose `field` array contains `value`. */
  arrayContains?: { field: string; value: unknown }
  /** Restrict to documents where `field === value`. */
  equals?: { field: string; value: unknown }
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
   * DECLARED BUT NOT YET WIRED — `docs.ts` still queries Firestore directly. It
   * is here because the port is only honest if it describes the whole surface,
   * and because the read path's filter-before-limit behaviour (D7) constrains
   * the shape: the store returns rows, the endpoint filters them, so `limit` is
   * applied by the CALLER after access filtering, not pushed down. Wiring
   * `docs.ts` is the remaining half of #7.
   */
  query(collection: string, options?: QueryOptions): Promise<StoredDoc[]>
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
      rows = rows.filter((r) => r.data[field] === value)
    }
    if (options.arrayContains) {
      const { field, value } = options.arrayContains
      rows = rows.filter((r) => {
        const held = r.data[field]
        return Array.isArray(held) && held.includes(value)
      })
    }

    const order = options.orderBy ?? '_created desc'
    const [field, direction] = order.split(' ')
    if (field !== '~') {
      const sign = direction === 'desc' ? -1 : 1
      rows.sort(
        (a, b) =>
          sign * String(a.data[field] ?? '').localeCompare(String(b.data[field] ?? ''))
      )
    }

    return options.limit ? rows.slice(0, options.limit) : rows
  }

  /** Test affordance: every stored path, for assertions. */
  paths(): string[] {
    return [...this.docs.keys()].sort()
  }
}
