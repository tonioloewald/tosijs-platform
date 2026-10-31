/**
 * The Store conformance suite (collections/store.suite.ts) against the
 * Firestore adapter, in-process, on the Firestore emulator. The same suite runs
 * against MemoryStore in collections/store-conformance.test.ts; together they
 * are the Phase 1 claim that the kernel cannot tell the substrates apart.
 *
 * It runs under the test process's emulator project (`demo-test`, set by
 * test-setup.ts, which also keeps every test off real projects), so it neither
 * reads nor disturbs the seeded project the endpoint suites use, and clears it
 * before and after. Skip-guarded like every integration suite: without the
 * emulator it reports [SKIPPED] and proves nothing.
 *
 * Run: npx -y firebase-tools@latest emulators:start --only firestore
 *      cd functions && bun test src/adapters/firebase/firestore-store.integration.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { test, expect, beforeAll, afterAll } from 'bun:test'

import { storeConformance } from '../../collections/store.suite'
import { firestoreSet, firestoreStoreFor } from './firestore-store'
import type { CollectionMap } from '../../collections/access'

const HOST = '127.0.0.1:8080'
const PROJECT = process.env.GCLOUD_PROJECT ?? ''
// Refuse outright rather than trust the preload: this suite WRITES.
if (
  process.env.FIRESTORE_EMULATOR_HOST !== HOST ||
  !PROJECT.startsWith('demo-')
) {
  throw new Error(
    'Store conformance: not pointed at the Firestore emulator; is test-setup.ts preloaded?'
  )
}
const CLEAR = `http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`

let running = false
try {
  running = (
    await fetch(`http://${HOST}/`, { signal: AbortSignal.timeout(2000) })
  ).ok
} catch {
  running = false
}

if (!running) {
  test('Store conformance: Firestore', () => {
    console.log(
      '   [SKIPPED] Firestore emulator not running at ' +
        HOST +
        ' — conformance NOT verified'
    )
  })
} else {
  beforeAll(async () => {
    await fetch(CLEAR, { method: 'DELETE' })
  })
  afterAll(async () => {
    await fetch(CLEAR, { method: 'DELETE' })
  })

  // Proof, not assumption, that the adapter is writing to THIS emulator: read
  // its write back over the emulator's own REST API.
  test('Store conformance: Firestore writes land in the emulator', async () => {
    const path = `conformance-probe/${Date.now()}`
    await firestoreSet(path, { probe: true })
    const res = await fetch(
      `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`,
      {
        headers: { Authorization: 'Bearer owner' },
      }
    )
    expect(res.status).toBe(200)
  })

  storeConformance(
    'Firestore (emulator)',
    {
      async make(seed = {}, { unique = {}, tagFields = {} } = {}) {
        const collections: CollectionMap = {}
        for (const [c, fields] of Object.entries(unique))
          collections[c] = { access: {}, ...collections[c], unique: fields }
        for (const [c, fields] of Object.entries(tagFields))
          collections[c] = { access: {}, ...collections[c], tagFields: fields }
        for (const [path, data] of Object.entries(seed))
          await firestoreSet(path, data)
        return firestoreStoreFor(collections)
      },
    },
    15000
  )
}
