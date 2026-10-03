/**
 * A computed store (owner, 2026-10-03): derived values that are INVALIDATED
 * eagerly and COMPUTED lazily.
 *
 * - `get(key, compute)`: a fresh stored value is returned as is (no work). A
 *   missing or stale one is computed, stored, and returned.
 * - `invalidate(keys)`: marks keys stale. Cheap, and it never computes, so the
 *   write path that calls it cannot half-fail on a render.
 *
 * Nothing renders "everything": a template or renderer change bumps the key
 * namespace's version, and every key misses and recomputes on its next read.
 *
 * The race this closes: a reader that started computing BEFORE a write could
 * finish AFTER the write's invalidation and store pre-write data, which would
 * then stay. So invalidation writes a stale MARKER (never a delete), and a
 * reader stores only if the key is unchanged since it looked (a version
 * precondition). If someone invalidated in between, the reader still returns
 * what it computed for its own caller, but does not store it.
 */

export interface Entry {
  value?: string
  stale?: boolean
  /** What this value was computed FROM (see Deps); a write to any of them invalidates it. */
  deps?: string[]
  /** When it was computed (ISO), for `maxAgeSeconds`. */
  computedAt?: string
  /** Anything a `validate` policy wants to check on read (e.g. a checksum of the sources). */
  check?: string
}

/**
 * How a value goes stale, besides being invalidated by a write to something it
 * read (always on):
 * - `maxAgeSeconds`: for values derived from things that never write to us
 *   (an external URL, as `cachedQuery` fetches);
 * - `validate`: asked on every read — e.g. compare a checksum of the sources
 *   with `check`. Costs that check on each read; worth it when the sources'
 *   writes cannot be observed, or checking is cheaper than recomputing.
 */
export interface Policy {
  maxAgeSeconds?: number
  validate?: (entry: Entry) => Promise<boolean>
}

/** Storage with compare-and-set on an opaque version. */
export interface ComputedBackend {
  read(key: string): Promise<{ entry?: Entry; version: string | null }>
  readMany(keys: string[]): Promise<Array<{ entry?: Entry; version: string | null }>>
  /** Write only if the key's version is still `expected` (null: does not exist). */
  writeIfUnchanged(key: string, entry: Entry, expected: string | null): Promise<boolean>
  /** Unconditional writes (stale markers). */
  writeAll(entries: Array<[string, Entry]>): Promise<void>
  /** Keys (fully qualified) whose recorded deps include any of these. */
  dependents(deps: string[]): Promise<string[]>
}

/**
 * Dependencies are recorded, not declared: a compute function reads through a
 * `Deps` recorder, which notes every source it touched.
 * - `doc:<collection>/<id>`            one document
 * - `doc:<collection>/<field>=<value>` a lookup by a unique field
 * - `list:<collection>`                a query over the collection
 * - `computed:<key>`                   another computed value (invalidation cascades)
 */
export class Deps {
  readonly seen = new Set<string>()
  add(dep: string): void {
    this.seen.add(dep)
  }
}

/**
 * The deps a committed write invalidates: the document itself, every unique
 * field's lookup before AND after (a rename moves it), and the list.
 */
export function depsOfWrite(
  collection: string,
  id: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  lookupFields: string[]
): string[] {
  const out = [`doc:${collection}/${id}`, `list:${collection}`]
  for (const f of lookupFields) {
    for (const d of [before, after]) {
      if (d && d[f] !== undefined && d[f] !== null) out.push(`doc:${collection}/${f}=${String(d[f])}`)
    }
  }
  return out
}

export interface Computed<T> {
  value: T
  /** False for a result that must not be kept (e.g. a draft only its link may show). */
  storable: boolean
  /** Stored alongside, for a `validate` policy to compare against later. */
  check?: string
}

export class ComputedStore {
  constructor(
    private backend: ComputedBackend,
    private namespace: string,
    private now: () => number = () => Date.now()
  ) {}

  private k(key: string): string {
    return `${this.namespace}:${key}`
  }

  private async fresh<T>(r: { entry?: Entry }, policy: Policy = {}): Promise<T | undefined> {
    const e = r.entry
    if (!e || e.stale || e.value === undefined) return undefined
    if (policy.maxAgeSeconds !== undefined) {
      const at = e.computedAt ? Date.parse(e.computedAt) : NaN
      if (!(this.now() - at < policy.maxAgeSeconds * 1000)) return undefined
    }
    if (policy.validate && !(await policy.validate(e))) return undefined
    return JSON.parse(e.value) as T
  }

  /**
   * `parent`: when called from INSIDE another compute, its recorder — so the
   * outer value depends on this one, and invalidating this cascades.
   */
  async get<T>(
    key: string,
    compute: (deps: Deps) => Promise<Computed<T>>,
    opts: { parent?: Deps; policy?: Policy } = {}
  ): Promise<T> {
    opts.parent?.add(`computed:${key}`)
    const r = await this.backend.read(this.k(key))
    const hit = await this.fresh<T>(r, opts.policy)
    if (hit !== undefined) return hit
    return this.fill(key, r.version, compute)
  }

  /** Several keys in one read; misses are computed one by one. */
  async getMany<T>(
    keys: string[],
    compute: (key: string, deps: Deps) => Promise<Computed<T>>,
    opts: { parent?: Deps; policy?: Policy } = {}
  ): Promise<T[]> {
    for (const k of keys) opts.parent?.add(`computed:${k}`)
    const rs = await this.backend.readMany(keys.map((k) => this.k(k)))
    return Promise.all(
      rs.map(async (r, i) => {
        const hit = await this.fresh<T>(r, opts.policy)
        return hit !== undefined ? hit : this.fill(keys[i], r.version, (d) => compute(keys[i], d))
      })
    )
  }

  /** What is stored for a key, without computing (undefined when missing or stale). */
  async peek<T>(key: string): Promise<T | undefined> {
    return this.fresh<T>(await this.backend.read(this.k(key)))
  }

  /** The stored deps of a key (for tests and diagnostics). */
  async depsOf(key: string): Promise<string[]> {
    return (await this.backend.read(this.k(key))).entry?.deps ?? []
  }

  async invalidate(keys: string[]): Promise<void> {
    if (!keys.length) return
    await this.backend.writeAll([...new Set(keys)].map((k) => [this.k(k), { stale: true }]))
  }

  /**
   * Invalidate everything computed from these sources, and everything computed
   * from THOSE (cascade), in this namespace. Returns the keys invalidated.
   */
  async invalidateDependents(deps: string[]): Promise<string[]> {
    const done = new Set<string>()
    let frontier = deps
    while (frontier.length) {
      const hits = (await this.backend.dependents(frontier))
        .filter((full) => full.startsWith(`${this.namespace}:`))
        .map((full) => full.slice(this.namespace.length + 1))
        .filter((k) => !done.has(k))
      hits.forEach((k) => done.add(k))
      frontier = hits.map((k) => `computed:${k}`)
    }
    await this.invalidate([...done])
    return [...done]
  }

  private async fill<T>(key: string, version: string | null, compute: (deps: Deps) => Promise<Computed<T>>): Promise<T> {
    const deps = new Deps()
    const { value, storable, check } = await compute(deps)
    if (storable) {
      // Lost the race (someone invalidated or filled meanwhile)? Then do not
      // store: the caller still gets what it computed.
      const entry: Entry = {
        value: JSON.stringify(value),
        deps: [...deps.seen],
        computedAt: new Date(this.now()).toISOString(),
      }
      if (check !== undefined) entry.check = check
      await this.backend
        .writeIfUnchanged(this.k(key), entry, version)
        .catch(() => false)
    }
    return value
  }
}

/** For tests: versions are counters. */
export class MemoryBackend implements ComputedBackend {
  data = new Map<string, { entry: Entry; version: string }>()
  private n = 0
  async read(key: string) {
    const d = this.data.get(key)
    return { entry: d?.entry, version: d?.version ?? null }
  }
  async readMany(keys: string[]) {
    return Promise.all(keys.map((k) => this.read(k)))
  }
  async writeIfUnchanged(key: string, entry: Entry, expected: string | null) {
    if ((this.data.get(key)?.version ?? null) !== expected) return false
    this.data.set(key, { entry, version: String(++this.n) })
    return true
  }
  async writeAll(entries: Array<[string, Entry]>) {
    for (const [k, entry] of entries) this.data.set(k, { entry: { ...this.data.get(k)?.entry, ...entry }, version: String(++this.n) })
  }
  async dependents(deps: string[]) {
    return [...this.data].filter(([, d]) => (d.entry.deps ?? []).some((x) => deps.includes(x))).map(([k]) => k)
  }
}
