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
}

export interface RegistryOptions {
  /** How long a loaded snapshot stays usable, ms. */
  ttlMs?: number
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
}

const DEFAULT_TTL_MS = 60_000

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

  private get clock(): () => number {
    return this.options.now ?? Date.now
  }

  /** Drop the cache. Call after any write that changes a collection config. */
  invalidate(): void {
    this.snapshot = null
  }

  async current(): Promise<RegistrySnapshot> {
    const now = this.clock()
    if (this.snapshot && now - this.snapshot.loadedAt < this.ttl) {
      return this.snapshot
    }
    // Collapse concurrent refreshes: a cold instance serving a burst should do
    // ONE load, not one per request.
    if (this.inFlight) return this.inFlight

    this.inFlight = (async () => {
      try {
        const stored = await this.source.load()
        const { collections, failed } = compileStored(
          stored,
          this.options.onError
        )
        this.snapshot = { collections, failed, loadedAt: this.clock() }
        return this.snapshot
      } catch (e) {
        this.options.onError?.(`registry: load failed: ${String(e)}`)
        // FAIL CLOSED. An unreadable config store yields no collections, so
        // /doc denies everything, rather than serving whatever happened to be
        // cached from before a revocation.
        this.snapshot = {
          collections: {},
          failed: [],
          loadedAt: this.clock(),
        }
        return this.snapshot
      } finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
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
