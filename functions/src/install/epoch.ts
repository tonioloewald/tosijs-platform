/**
 * The registry epoch — how a rule change reaches instances you are not looking
 * at (tosijs-platform#5, #7).
 *
 * `CollectionRegistry.invalidate()` clears the cache on ONE instance: the one
 * that happened to serve the install request. Every other warm instance keeps
 * compiling and enforcing the old configs until its TTL expires. For an install
 * that is merely slow; for a REVOKE it is the wrong failure in the wrong
 * direction — the grant you just removed stays live, elsewhere, for up to a
 * minute, on machines whose logs you are not reading.
 *
 * So a change bumps a single counter, and every instance re-reads that one tiny
 * value on a short interval. Steady state is one small read every few seconds
 * per warm instance; a real change propagates within that interval everywhere
 * at once.
 *
 * ## Why `system:` and not a real collection
 *
 * `system:registry` is not in COLLECTIONS and never will be. Deny-by-default
 * therefore makes it unreachable through `/doc` and `/docs` for everyone,
 * including owner — which is what you want for a value whose only job is to be
 * trustworthy: an epoch an attacker can pin is an epoch that stops propagating
 * revocations, so the quietest possible attack on this system is `PUT` on the
 * epoch document. It is written by the install handler with admin credentials
 * and by nothing else.
 *
 * It shares the `system:` namespace with the claim ceremony for the same
 * reason. `:` cannot appear in a bare platform collection name, so no manifest
 * can declare it either (see namespace.ts).
 */

import * as admin from 'firebase-admin'

export const EPOCH_PATH = { collection: 'system:registry', doc: 'epoch' }

export const epochRef = (): FirebaseFirestore.DocumentReference =>
  admin.firestore().collection(EPOCH_PATH.collection).doc(EPOCH_PATH.doc)

const bumpValue = () => ({
  // Monotonic by increment rather than by clock: two installs in the same
  // millisecond would produce the same timestamp, and an instance that had
  // already seen that value would skip the reload. `FieldValue.increment` is
  // atomic server-side, so concurrent installs cannot lose a bump either.
  value: admin.firestore.FieldValue.increment(1),
  at: new Date().toJSON(),
})

/**
 * Bump the epoch as PART of the batch that changes config.
 *
 * Prefer this over `bumpEpoch()` wherever a batch exists. A bump issued after a
 * successful commit can be lost — the process is killed, the network drops, the
 * function times out — and the failure mode is silent and durable: the config
 * changed, the epoch did not, and every other instance keeps enforcing the old
 * rules indefinitely rather than for a few seconds. Batching makes "the rules
 * changed" and "everyone find out" the same write.
 */
export function bumpEpochIn(batch: FirebaseFirestore.WriteBatch): void {
  batch.set(epochRef(), bumpValue(), { merge: true })
}

/** Standalone bump, for paths with no batch to join. */
export async function bumpEpoch(): Promise<void> {
  await epochRef().set(bumpValue(), { merge: true })
}

/**
 * Read the current epoch.
 *
 * A missing document reads as 0, which is correct for a host that has never
 * installed anything. An unreadable one THROWS rather than defaulting, because
 * `CollectionRegistry` treats a failed epoch check as "freshness unknown" and
 * reloads — swallowing the error here would turn that into "unchanged" and
 * silently freeze the rules.
 */
export async function readEpoch(): Promise<number> {
  const snapshot = await admin
    .firestore()
    .collection(EPOCH_PATH.collection)
    .doc(EPOCH_PATH.doc)
    .get()
  return (snapshot.data()?.value as number) ?? 0
}
