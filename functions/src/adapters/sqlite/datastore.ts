/**
 * SQLite as the host's datastore (datastore.ts), installed by the Bun server.
 *
 * One file, one connection per process: the documents, the render cache and
 * its invalidation log share it, so all their writes queue behind one another
 * and wait for other processes the same way (store.ts).
 */
import type { CollectionMap } from '../../collections/access'
import type { DataStoreProvider } from '../../datastore'
import { sqliteComputedBackend } from './computed-backend'
import { SqliteStore, type SqliteKeys } from './store'

/** `field=value` keys, from the collection map: `unique` by equality, `tagFields` by array-contains. */
export function keysOf(collections: CollectionMap): SqliteKeys {
  const keys: Required<SqliteKeys> = { unique: {}, tagFields: {} }
  for (const [name, config] of Object.entries(collections)) {
    if (config.unique?.length) keys.unique[name] = [...config.unique]
    if (config.tagFields?.length) keys.tagFields[name] = [...config.tagFields]
  }
  return keys
}

export function sqliteDataStore(file: string): DataStoreProvider & { close(): void } {
  const store = new SqliteStore(file)
  return {
    store,
    storeFor: (collections) => store.withKeys(keysOf(collections)),
    computedBackend: (collection, logCollection) => sqliteComputedBackend(store, collection, logCollection),
    close: () => store.close(),
  }
}
