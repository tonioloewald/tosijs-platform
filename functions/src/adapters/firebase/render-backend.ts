/**
 * The render store's backend (`ComputedBackend`, render/computed.ts) on
 * Firestore, moved out of render/store.ts unchanged (SOVEREIGN-PLAN.md
 * Phase 1).
 *
 * `ComputedBackend` is already a port: `MemoryBackend` (computed.ts) is the
 * other implementation and the one the tests run. This one leans on two
 * Firestore specifics the Store port does not offer — a document's update time
 * as its version (the `writeIfUnchanged` precondition) and `array-contains-any`
 * (`dependents`) — so a sovereign host implements the interface on its own
 * store rather than over `Store`.
 */
import { firebaseAdmin } from './app'
// Modular imports, not `admin.firestore.FieldValue`: the functions emulator
// wraps the `admin.firestore` namespace WITHOUT its static members, so the
// namespace form threw there (found 2026-10-22) while working in production.
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import type { ComputedBackend, Entry } from '../../render/computed'

/** A lost race, as Firestore reports it: anything else is a real failure. */
const isLostRace = (e: unknown) => {
  const code = (e as { code?: number | string })?.code
  // 6 ALREADY_EXISTS, 9 FAILED_PRECONDITION; 5 NOT_FOUND (purged mid-fill) and
  // 10 ABORTED mean the same thing here: someone else changed the key.
  return [5, 6, 9, 10, 'not-found', 'already-exists', 'failed-precondition', 'aborted'].includes(code as never)
}
const versionOf = (snap: FirebaseFirestore.DocumentSnapshot): string | null =>
  snap.exists && snap.updateTime ? `${snap.updateTime.seconds}.${snap.updateTime.nanoseconds}` : null

/** Values in `collection`, one document per key; invalidations logged in `logCollection`. */
export function firestoreComputedBackend(collection: string, logCollection: string): ComputedBackend {
  const docRef = (key: string) => firebaseAdmin().firestore().collection(collection).doc(encodeURIComponent(key))
  const logRef = (dep: string) =>
    firebaseAdmin().firestore().collection(logCollection).doc(encodeURIComponent(dep).slice(0, 1400))

  return {
    async read(key) {
      const snap = await docRef(key).get()
      return { entry: snap.exists ? (snap.data() as Entry) : undefined, version: versionOf(snap) }
    },
    async readMany(keys) {
      if (!keys.length) return []
      const snaps = await firebaseAdmin().firestore().getAll(...keys.map(docRef))
      return snaps.map((s) => ({ entry: s.exists ? (s.data() as Entry) : undefined, version: versionOf(s) }))
    },
    async writeIfUnchanged(key, entry, expected) {
      const ref = docRef(key)
      // Every field written, so a recompute never inherits an old `check`.
      const full = { key, value: entry.value, deps: entry.deps ?? [], computedAt: entry.computedAt, check: entry.check ?? null }
      try {
        if (expected === null) {
          await ref.create(full) // fails if someone created it meanwhile
        } else {
          const [s, n] = expected.split('.').map(Number)
          await ref.update(
            { ...full, stale: FieldValue.delete() },
            { lastUpdateTime: new Timestamp(s, n) }
          )
        }
        return true
      } catch (e) {
        if (isLostRace(e)) return false // invalidated or filled since we read it
        throw e // too large, quota, permission…: a real failure, reported by the store
      }
    },
    async writeAll(entries) {
      // Merge: a stale marker keeps the recorded deps, so cascades still find it.
      const writer = firebaseAdmin().firestore().bulkWriter()
      let failed = 0
      writer.onWriteError((err) => {
        if (err.failedAttempts < 3) return true // retry
        failed++
        return false
      })
      for (const [key, entry] of entries) writer.set(docRef(key), { ...entry, key }, { merge: true }).catch(() => undefined)
      await writer.close()
      if (failed) throw new Error(`${failed} stale marker(s) could not be written`)
    },
    async dependents(deps) {
      const out = new Set<string>()
      for (let i = 0; i < deps.length; i += 30) {
        const snap = await firebaseAdmin().firestore()
          .collection(collection)
          .where('deps', 'array-contains-any', deps.slice(i, i + 30))
          .select('key')
          .get()
        for (const d of snap.docs) out.add(d.data().key as string)
      }
      return [...out]
    },
    async logInvalidation(deps) {
      // Chunked, never truncated: an unlogged dep would reopen the first-fill race.
      for (let i = 0; i < deps.length; i += 450) {
        const batch = firebaseAdmin().firestore().batch()
        for (const dep of deps.slice(i, i + 450)) batch.set(logRef(dep), { dep, at: FieldValue.serverTimestamp() })
        await batch.commit()
      }
    },
    async invalidatedSince(deps, sinceMs) {
      if (!deps.length) return false
      const snaps = await firebaseAdmin().firestore().getAll(...deps.map(logRef))
      return snaps.some((s) => {
        const at = s.exists ? (s.data()?.at as Timestamp | undefined) : undefined
        return Boolean(at && at.toMillis() >= sinceMs)
      })
    },
  }
}
