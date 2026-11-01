/**
 * The datastore port's composition point (SOVEREIGN-PLAN.md Phase 2).
 *
 * Kernel code reads and writes documents through `dataStore` and resolves
 * request paths through `storeFor(collections)`; the render cache keeps its
 * values through `computedBackend(…)`. None of them names a substrate: the
 * host installs one at startup with `setDataStoreProvider` (index.ts installs
 * Firestore; the Bun server installs SQLite), as the identity port does.
 *
 * Until a provider is installed every call REJECTS, so an unconfigured host
 * fails closed, and a unit test that wanders into the datastore fails fast
 * instead of reaching a real one.
 *
 * `dataStore` and `computedBackend()` forward each call to the provider
 * installed AT CALL TIME, because modules capture them at load (the install
 * registry, the render store), before index.ts has installed anything.
 */
import type { Store } from './collections/store'
import type { CollectionMap } from './collections/access'
import type { ComputedBackend } from './render/computed'

/** The store as kernel code uses it directly: everything but path resolution. */
export type DataStore = Omit<Store, 'resolve' | 'isUnique'>

export interface DataStoreProvider {
  /** The store, for code that needs no `field=value` resolution. */
  store: DataStore
  /**
   * The full store for one request: `field=value` resolves against THIS map
   * (`unique`/`tagFields`), so an installed collection's keys are honoured.
   */
  storeFor(collections: CollectionMap): Store
  /** The render cache's backend: values in `collection`, invalidations in `logCollection`. */
  computedBackend(collection: string, logCollection: string): ComputedBackend
}

const unconfigured = (): never => {
  throw new Error('no datastore is installed')
}
const refuse = async (): Promise<never> => unconfigured()

const UNCONFIGURED: DataStoreProvider = {
  store: {
    get: refuse,
    set: refuse,
    delete: refuse,
    query: refuse,
    transaction: refuse,
    // eslint-disable-next-line require-yield
    async* scan() {
      unconfigured()
    },
  },
  storeFor: unconfigured,
  computedBackend: unconfigured,
}

let provider: DataStoreProvider = UNCONFIGURED

/** Install the host's datastore; returns the one it replaced (tests restore it). */
export function setDataStoreProvider(p: DataStoreProvider | null): DataStoreProvider {
  const previous = provider
  provider = p ?? UNCONFIGURED
  return previous
}

/** The installed store, forwarded at call time. */
export const dataStore: DataStore = {
  get: (path) => provider.store.get(path),
  set: (path, data) => provider.store.set(path, data),
  delete: (path) => provider.store.delete(path),
  query: (collection, options) => provider.store.query(collection, options),
  scan: (collection, options, pageSize) => provider.store.scan(collection, options, pageSize),
  transaction: (fn) => provider.store.transaction(fn),
}

/** The installed store for one request's collection map. */
export const storeFor = (collections: CollectionMap): Store => provider.storeFor(collections)

/** A render-cache backend that binds to the installed provider on first use. */
export function computedBackend(collection: string, logCollection: string): ComputedBackend {
  let bound: { to: DataStoreProvider; backend: ComputedBackend } | null = null
  const backend = (): ComputedBackend => {
    if (bound?.to !== provider) {
      bound = { to: provider, backend: provider.computedBackend(collection, logCollection) }
    }
    return bound.backend
  }
  // async: an unconfigured provider throws, and that must be a rejection.
  return {
    read: async (key) => backend().read(key),
    readMany: async (keys) => backend().readMany(keys),
    writeIfUnchanged: async (key, entry, expected) => backend().writeIfUnchanged(key, entry, expected),
    writeAll: async (entries) => backend().writeAll(entries),
    dependents: async (deps) => backend().dependents(deps),
    logInvalidation: async (deps) => backend().logInvalidation(deps),
    invalidatedSince: async (deps, sinceMs) => backend().invalidatedSince(deps, sinceMs),
  }
}
