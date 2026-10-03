/**
 * A computed store (owner, 2026-10-03): derived values that are INVALIDATED
 * eagerly and COMPUTED lazily.
 *
 * - `get(key, compute)`: a fresh stored value is returned as is (no work). A
 *   missing or stale one is computed, stored, and returned.
 * - `invalidateDependents(deps)`: marks stale every value computed from those
 *   sources (cascading). Cheap; it never computes, so the write path that
 *   calls it cannot half-fail on a render.
 *
 * INVARIANT (adversarial review, 2026-10-03): a compute depends ONLY on its key
 * and on what it reads through its `Deps` recorder. A request-derived argument
 * that is not in the key would let whoever triggers a recompute choose what
 * everyone else is served (cache poisoning).
 *
 * Nothing renders "everything": a template or renderer change bumps the
 * namespace, and every key misses and recomputes on its next read.
 *
 * ## Races
 *
 * A reader computing across a write must not store pre-write data. Two cases:
 * 1. The key EXISTS and the write's invalidation marks it stale while the
 *    reader computes: the reader stores only if the key is unchanged since it
 *    looked (a version precondition), so it loses and does not store.
 * 2. The key does NOT exist yet (or its deps just changed): the write's
 *    `dependents()` cannot see it, and the reader's create succeeds. So the
 *    writer first LOGS what it invalidated (with a time), and the reader,
 *    after storing, checks the log for its deps since it started; if any were
 *    invalidated, it marks its own key stale. Writer logs before searching;
 *    reader stores before checking: one of the two always sees the other.
 * Plus a backstop max age on every value, for changes no hook sees.
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
 *   (an external URL), and as a backstop for changes no hook observes;
 * - `validate`: asked on every read — e.g. compare a checksum of the sources
 *   with `check`.
 */
export interface Policy {
  maxAgeSeconds?: number
  validate?: (entry: Entry) => Promise<boolean>
}

/** Storage with compare-and-set on an opaque version, plus the invalidation log. */
export interface ComputedBackend {
  read(key: string): Promise<{ entry?: Entry; version: string | null }>
  readMany(keys: string[]): Promise<Array<{ entry?: Entry; version: string | null }>>
  /**
   * Write only if the key's version is still `expected` (null: does not exist).
   * Resolves false when the precondition fails (a lost race); REJECTS on any
   * other error, which the store logs — a failure is not a race.
   */
  writeIfUnchanged(key: string, entry: Entry, expected: string | null): Promise<boolean>
  /** Unconditional merges (stale markers keep their deps). */
  writeAll(entries: Array<[string, Entry]>): Promise<void>
  /** Keys whose recorded deps include any of these. */
  dependents(deps: string[]): Promise<string[]>
  /** Record that these deps were invalidated now. */
  logInvalidation(deps: string[]): Promise<void>
  /** Were any of these deps invalidated at or after `sinceMs`? */
  invalidatedSince(deps: string[], sinceMs: number): Promise<boolean>
}

/**
 * Dependencies are recorded, not declared: a compute function reads through a
 * `Deps` recorder, which notes every source it touched.
 * - `doc:<collection>/<id>`            one document
 * - `doc:<collection>/<field>=<value>` a lookup by a unique field
 * - `list:<collection>`                a query over the collection
 * - `computed:<namespace>:<key>`       another computed value (invalidation cascades)
 */
export class Deps {
  readonly seen = new Set<string>()
  /** Set when the compute read something no write would invalidate: the value is then not stored. */
  unstorable?: string
  add(dep: string): void {
    this.seen.add(dep)
  }
  /** Mark the value as not keepable, with the reason (reported, never silent). */
  cannotStore(reason: string): void {
    this.unstorable ??= reason
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

export interface StoreOptions {
  /** Applied to every get unless the call overrides it: the backstop max age. */
  defaultPolicy?: Policy
  now?: () => number
  /** Where non-race failures are reported (never silently swallowed). */
  onError?: (what: string, e: unknown) => void
  /** Clock skew allowed between the reader's clock and the log's timestamps. */
  skewMs?: number
  /**
   * Which recorded deps a STORED value may have: only what a write would
   * invalidate. A value that read anything else is returned but not kept —
   * enforced here for every compute, not left to each renderer (re-review).
   */
  isInvalidatedDep?: (dep: string) => boolean
}

export class ComputedStore {
  private now: () => number
  private onError: (what: string, e: unknown) => void
  private skewMs: number

  constructor(private backend: ComputedBackend, readonly namespace: string, private opts: StoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.onError = opts.onError ?? (() => undefined)
    this.skewMs = opts.skewMs ?? 2000
  }

  /** The dep another compute records when it reads this key. */
  dep(key: string): string {
    return `computed:${this.namespace}:${key}`
  }

  private async fresh<T>(r: { entry?: Entry }, policy: Policy): Promise<T | undefined> {
    const e = r.entry
    if (!e || e.stale || e.value === undefined) return undefined
    if (policy.maxAgeSeconds !== undefined) {
      const at = e.computedAt ? Date.parse(e.computedAt) : NaN
      if (!(this.now() - at < policy.maxAgeSeconds * 1000)) return undefined
    }
    if (policy.validate && !(await policy.validate(e))) return undefined
    return JSON.parse(e.value) as T
  }

  async get<T>(
    key: string,
    compute: (deps: Deps) => Promise<Computed<T>>,
    opts: { parent?: Deps; policy?: Policy } = {}
  ): Promise<T> {
    opts.parent?.add(this.dep(key))
    const policy = { ...this.opts.defaultPolicy, ...opts.policy }
    const r = await this.backend.read(key)
    const hit = await this.fresh<T>(r, policy)
    if (hit !== undefined) return hit
    return this.fill(key, r.version, compute)
  }

  /** Several keys in one read; misses are computed one by one. */
  async getMany<T>(
    keys: string[],
    compute: (key: string, deps: Deps) => Promise<Computed<T>>,
    opts: { parent?: Deps; policy?: Policy } = {}
  ): Promise<T[]> {
    for (const k of keys) opts.parent?.add(this.dep(k))
    const policy = { ...this.opts.defaultPolicy, ...opts.policy }
    const rs = await this.backend.readMany(keys)
    return Promise.all(
      rs.map(async (r, i) => {
        const hit = await this.fresh<T>(r, policy)
        return hit !== undefined ? hit : this.fill(keys[i], r.version, (d) => compute(keys[i], d))
      })
    )
  }

  /** What is stored for a key, without computing (undefined when missing or stale). */
  async peek<T>(key: string): Promise<T | undefined> {
    return this.fresh<T>(await this.backend.read(key), {})
  }

  /** The stored deps of a key (for tests and diagnostics). */
  async depsOf(key: string): Promise<string[]> {
    return (await this.backend.read(key)).entry?.deps ?? []
  }

  async invalidate(keys: string[]): Promise<void> {
    if (!keys.length) return
    await this.backend.writeAll([...new Set(keys)].map((k) => [k, { stale: true }]))
  }

  /**
   * Invalidate everything computed from these sources, and everything computed
   * from THOSE (cascade). LOGS first (see Races), and marks each round as it is
   * found, so a failure part-way still leaves the first rounds stale.
   */
  async invalidateDependents(deps: string[]): Promise<string[]> {
    const done = new Set<string>()
    let frontier = [...new Set(deps)]
    while (frontier.length) {
      try {
        await this.backend.logInvalidation(frontier)
      } catch (e) {
        // The log only guards the first-fill race; marking dependents stale
        // must happen regardless (re-review: a failed log write must not drop
        // the invalidation itself).
        this.onError(`invalidation log ${this.namespace}`, e)
      }
      const hits = (await this.backend.dependents(frontier)).filter((k) => !done.has(k))
      hits.forEach((k) => done.add(k))
      await this.invalidate(hits)
      frontier = hits.map((k) => this.dep(k))
    }
    return [...done]
  }

  private async fill<T>(key: string, version: string | null, compute: (deps: Deps) => Promise<Computed<T>>): Promise<T> {
    const started = this.now()
    const deps = new Deps()
    const { value, storable, check } = await compute(deps)
    if (!storable) return value
    const unwatched = this.opts.isInvalidatedDep ? [...deps.seen].filter((d) => !this.opts.isInvalidatedDep?.(d)) : []
    if (deps.unstorable || unwatched.length) {
      this.onError(`not storing ${this.namespace}:${key}`, new Error(deps.unstorable ?? `reads nothing invalidates: ${unwatched.join(', ')}`))
      return value
    }
    const entry: Entry = {
      value: JSON.stringify(value),
      deps: [...deps.seen],
      computedAt: new Date(started).toISOString(),
    }
    if (check !== undefined) entry.check = check
    let stored = false
    try {
      // Case 1: lost to an invalidation (or another filler) of an existing key.
      stored = await this.backend.writeIfUnchanged(key, entry, version)
    } catch (e) {
      this.onError(`store ${this.namespace}:${key}`, e)
    }
    if (stored && entry.deps?.length) {
      // Case 2: a write invalidated one of our sources while we computed, but
      // could not see this key (it did not exist, or had other deps then).
      try {
        if (await this.backend.invalidatedSince(entry.deps, started - this.skewMs)) await this.invalidate([key])
      } catch (e) {
        // Cannot tell: do not trust what we just stored.
        this.onError(`race check ${this.namespace}:${key}`, e)
        await this.invalidate([key]).catch(() => undefined)
      }
    }
    return value
  }
}

/** For tests: versions are counters, and the clock is injectable. */
export class MemoryBackend implements ComputedBackend {
  data = new Map<string, { entry: Entry; version: string }>()
  log = new Map<string, number>()
  private n = 0
  constructor(private now: () => number = () => Date.now()) {}
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
  async logInvalidation(deps: string[]) {
    for (const d of deps) this.log.set(d, this.now())
  }
  async invalidatedSince(deps: string[], sinceMs: number) {
    return deps.some((d) => (this.log.get(d) ?? -Infinity) >= sinceMs)
  }
}
