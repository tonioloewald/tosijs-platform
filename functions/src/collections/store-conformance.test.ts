/**
 * The Store conformance suite (store.suite.ts) against MemoryStore. The same
 * suite runs against the Firestore emulator in
 * adapters/firebase/firestore-store.integration.test.ts.
 *
 * Run: cd functions && bun test src/collections/store-conformance.test.ts
 */
import { MemoryStore } from './store'
import { storeConformance } from './store.suite'

storeConformance('MemoryStore', {
  async make(seed = {}, { unique = {}, tagFields = {} } = {}) {
    const keyFields: Record<string, string[]> = {}
    for (const [collection, fields] of [
      ...Object.entries(unique),
      ...Object.entries(tagFields),
    ]) {
      keyFields[collection] = [...(keyFields[collection] ?? []), ...fields]
    }
    return new MemoryStore(seed, keyFields)
  },
})
