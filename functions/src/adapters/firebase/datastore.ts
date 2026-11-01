/**
 * Firestore as the host's datastore (datastore.ts), installed by index.ts.
 */
import type { DataStoreProvider } from '../../datastore'
import { firestoreStore, firestoreStoreFor } from './firestore-store'
import { firestoreComputedBackend } from './render-backend'

export const firebaseDataStore: DataStoreProvider = {
  store: firestoreStore,
  storeFor: firestoreStoreFor,
  computedBackend: firestoreComputedBackend,
}
