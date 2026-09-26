/**
 * The collection registry — collection configs as DATA (#5, #7).
 *
 * `COLLECTIONS` is a module-level map populated by import-time side effects, so
 * what a host can do is fixed at build time. That is the thing an install system
 * has to remove: a collection must be definable by writing a document, not by
 * shipping TypeScript.
 *
 * ## No platform collections, only installed ones
 *
 * The registry makes no distinction between `post` and `virta:task`. Both are
 * stored configs; bare names simply belong to the platform's own namespace. That
 * collapses "dogfood the blog as a manifest" from a milestone into the normal
 * case — there is no other case.
 *
 * ## No compiled authority, including for owner
 *
 * There is deliberately NO hardcoded `owner ⇒ ALL` escape hatch. Owner's real
 * power is datastore access (D3), which lives outside anything this code can
 * grant or revoke, and DECISIONS.md already retracted one design that invented
 * an in-system second root. An empty or unreadable config store therefore fails
 * CLOSED: every collection is undefined, `/doc` denies everything, and the only
 * way back is the datastore — which is exactly the recovery story D3 describes.
 *
 * ## The bootstrap is not circular
 *
 * Reading configs is a PRIVILEGED INTERNAL read, not a `/doc` request, so it is
 * not governed by the configs it is fetching. That mechanism is not new:
 * `getUserRoles` already reads the `role` collection this way. Internal reads
 * are infrastructure; the access model governs external requests.
 *
 * ## One bad config must not take down the host
 *
 * Configs are compiled INDEPENDENTLY and a failure is isolated to its own
 * collection. A single malformed document making every collection unavailable
 * would turn a typo into an outage, and — worse — an attacker who could get one
 * bad config stored could deny the whole service. A broken config denies exactly
 * its own collection, loudly.
 */

import type { CollectionConfig, CollectionMap } from './access'
import type { InstalledCollection } from '../install/manifest'
import { compileCollection } from '../install/compile'

/** A collection config as stored. */
export interface StoredCollectionConfig {
  /** Logical name: `post`, `virta:task`. */
  name: string
  /** Which manifest/namespace it came from; null for the platform's own. */
  namespace?: string | null
  /** The declarative definition — the same shape a manifest carries. */
  collection: InstalledCollection
  /** Version of the manifest that installed it, for provenance. */
  version?: string
}

/**
 * Where configs come from. Injected, so the registry is substrate-agnostic —
 * the whole point of #7, and what lets the cross-architecture tests assert that
 * identical data yields identical behaviour on Firestore and in memory.
 */
export interface ConfigSource {
  load(): Promise<StoredCollectionConfig[]>
  /**
   * A cheap "has anything changed?" probe — one tiny read, not the whole set.
   *
   * WITHOUT this, cache invalidation does not actually work in production.
   * `invalidate()` clears the instance that handled the request; every OTHER
   * instance keeps serving the old rules until its TTL expires. For a
   * revocation that is precisely the wrong failure: the grant you just removed
   * stays live, on machines you are not looking at, for up to a minute.
   *
   * With it, each instance re-checks a single epoch value on a short interval
   * and reloads only when it actually moved. Steady state costs one small read
   * every few seconds per warm instance; a real change propagates within that
   * interval everywhere at once.
   *
   * Optional: a source without one falls back to TTL-only, which is correct for
   * a static source and honest about being weaker for a live one.
   */
  epoch?(): Promise<string | number>
}

export interface RegistryOptions {
  /** How long a loaded snapshot stays usable without ANY check, ms. */
  ttlMs?: number
  /**
   * How often to re-check the epoch, ms. This is the real staleness bound for a
   * rule change, so it is deliberately short — the check is one small read.
   */
  epochTtlMs?: number
  /** Injected clock, so cache behaviour is testable without waiting. */
  now?: () => number
  /** Where compile failures go. Never throws the host down. */
  onError?: (message: string) => void
}

export interface RegistrySnapshot {
  collections: CollectionMap
  /** Names whose stored config could not be compiled. */
  failed: string[]
  loadedAt: number
  /** The epoch this snapshot was built from, when the source reports one. */
  epoch?: string | number
  /** When the epoch was last confirmed unchanged. */
  checkedAt: number
}

const DEFAULT_TTL_MS = 60_000
const DEFAULT_EPOCH_TTL_MS = 5_000

/**
 * Compile a set of stored configs into a `CollectionMap`.
 *
 * Pure. Exported because it is the unit the cross-architecture tests compare:
 * given the same stored documents, every substrate must produce the same map.
 */
export function compileStored(
  stored: StoredCollectionConfig[],
  onError: (message: string) => void = () => undefined
): { collections: CollectionMap; failed: string[] } {
  const collections: CollectionMap = {}
  const failed: string[] = []
  for (const entry of stored) {
    if (!entry?.name || !entry.collection) {
      failed.push(entry?.name ?? '(unnamed)')
      onError(`registry: unusable config entry ${JSON.stringify(entry?.name)}`)
      continue
    }
    try {
      collections[entry.name] = compileCollection(entry.collection)
    } catch (e) {
      // Isolated on purpose — see the header. This collection is now
      // unavailable; every other one is unaffected.
      failed.push(entry.name)
      onError(`registry: "${entry.name}" failed to compile: ${String(e)}`)
    }
  }
  return { collections, failed }
}

/**
 * Caches compiled configs and refreshes them on a TTL.
 *
 * The cache is the part most likely to bite: `/doc` consults it on every
 * request, so a stale entry means a revoked grant stays live until it expires.
 * `invalidate()` exists so a write that CHANGES config can drop the cache
 * immediately rather than waiting — the install path must call it.
 */
export class CollectionRegistry {
  private snapshot: RegistrySnapshot | null = null
  private inFlight: Promise<RegistrySnapshot> | null = null

  constructor(
    private readonly source: ConfigSource,
    private readonly options: RegistryOptions = {}
  ) {}

  private get ttl(): number {
    return this.options.ttlMs ?? DEFAULT_TTL_MS
  }

  private get epochTtl(): number {
    return this.options.epochTtlMs ?? DEFAULT_EPOCH_TTL_MS
  }

  private get clock(): () => number {
    return this.options.now ?? Date.now
  }

  /**
   * Bumped whenever a load already in flight must NOT be trusted: after
   * `invalidate()`, and when a check sees the epoch move. A load compares its
   * generation on completion and discards itself if it is stale, so a request
   * that has seen a change can never join — or be overwritten by — a load that
   * started before it (0.2.0-beta.5 review).
   */
  private generation = 0

  /** Drop the cache. Call after any write that changes a collection config. */
  invalidate(): void {
    this.snapshot = null
    this.generation++
    this.inFlight = null
  }

  async current(): Promise<RegistrySnapshot> {
    const now = this.clock()
    const snap = this.snapshot

    if (snap) {
      const fresh = now - snap.loadedAt < this.ttl
      if (fresh && now - snap.checkedAt < this.epochTtl) return snap
      if (this.source.epoch) {
        // Confirm nothing changed, cheaply, so an invalidation on ANOTHER
        // instance reaches this one.
        try {
          const current = await this.source.epoch()
          if (current === snap.epoch) {
            snap.checkedAt = now
            // Past the hard TTL but CONFIRMED current: serve the snapshot and
            // re-read in the background. The epoch is what vouches for
            // freshness; the TTL reload is belt-and-braces, and paying it
            // inline put a full load + compile on one request per instance per
            // minute — a p99 of ~950 ms against ~330 ms on a production clone
            // (reviews/2026-09-25-registry-swap-measurement.md). A change is
            // reloaded INLINE below, by a fresh load, never by joining this one.
            if (!fresh) void this.reload({ background: true })
            return snap
          }
          // Changed: a fresh, inline reload that no earlier load can satisfy.
          return this.reload({ fresh: true })
        } catch (e) {
          // An epoch we cannot read is an epoch we cannot trust. Reload rather
          // than keep serving rules whose freshness is unknown.
          this.options.onError?.(`registry: epoch check failed: ${String(e)}`)
          return this.reload({ fresh: true })
        }
      } else if (fresh) {
        // No epoch support: TTL is all there is, and nothing vouches for the
        // snapshot once it expires — so that reload stays inline.
        snap.checkedAt = now
        return snap
      }
    }
    return this.reload()
  }

  /**
   * Load and compile. Never rejects, so it is safe to fire without awaiting.
   *
   * - The epoch is read BEFORE the load. Read after, a config change landing
   *   mid-load would tag the OLD rules with the NEW epoch, and every check
   *   would then confirm them as current until the TTL. Read before, the worst
   *   case is new rules under an old epoch — which the next check reloads.
   * - `fresh` discards any load in flight: it may predate the change.
   * - A failed INLINE load fails closed (empty snapshot: nothing is served on
   *   rules nobody could read). A failed BACKGROUND load keeps the snapshot
   *   the epoch just confirmed as current — emptying it would take every
   *   collection on the instance offline for a transient read error, which is
   *   broader than the per-collection failure the owner chose.
   */
  private reload(
    { background = false, fresh = false }: { background?: boolean; fresh?: boolean } = {}
  ): Promise<RegistrySnapshot> {
    if (fresh) {
      this.generation++
      this.inFlight = null
    }
    // Collapse concurrent refreshes: a cold instance serving a burst should do
    // ONE load, not one per request.
    if (this.inFlight) return this.inFlight

    const generation = this.generation
    const current = () => generation === this.generation
    // Declared first so `finally` can tell whether it is still the in-flight load.
    let load: Promise<RegistrySnapshot> | undefined = undefined
    load = (async () => {
      try {
        const epoch = this.source.epoch
          ? await this.source.epoch().catch(() => undefined)
          : undefined
        const stored = await this.source.load()
        const { collections, failed } = compileStored(
          stored,
          this.options.onError
        )
        const at = this.clock()
        const snapshot: RegistrySnapshot = {
          collections,
          failed,
          loadedAt: at,
          checkedAt: at,
          epoch,
        }
        if (current()) this.snapshot = snapshot
        return snapshot
      } catch (e) {
        this.options.onError?.(`registry: load failed: ${String(e)}`)
        if (background && this.snapshot) return this.snapshot
        const at = this.clock()
        const empty: RegistrySnapshot = {
          collections: {},
          failed: [],
          loadedAt: at,
          checkedAt: at,
        }
        if (current()) this.snapshot = empty
        return empty
      } finally {
        if (this.inFlight === load) this.inFlight = null
      }
    })()
    this.inFlight = load
    return load
  }

  /** The whole map, for `getMethodAccess`. */
  async collections(): Promise<CollectionMap> {
    return (await this.current()).collections
  }

  /** One config, or undefined — which `/doc` already treats as deny. */
  async resolve(name: string): Promise<CollectionConfig | undefined> {
    return (await this.current()).collections[name]
  }
}

/** Trivial in-memory source, for tests and for seeding. */
export class StaticConfigSource implements ConfigSource {
  constructor(private readonly entries: StoredCollectionConfig[]) {}
  async load(): Promise<StoredCollectionConfig[]> {
    return this.entries
  }
}
