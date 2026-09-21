/**
 * Monotonic per-collection sequence numbers (#14).
 *
 * `_created`/`_modified` cannot order a replica's resume. Two writes in the
 * same millisecond are indistinguishable, and — worse — the stamps come from
 * the *function instance's* clock, and instances drift independently. A later
 * write can carry an earlier timestamp than one a replica has already passed,
 * so the replica silently misses it. Silently is the problem: a sync that
 * loses events without erroring is worse than one that fails.
 *
 * So a real counter, read and written in the same transaction as the document.
 *
 * ## The cost, stated plainly
 *
 * Every sequenced write goes through one counter document, so writes to a
 * sequenced collection SERIALISE. Firestore sustains roughly one write per
 * second per document, and that becomes the collection's write ceiling.
 *
 * That is not a Firestore quirk to engineer around — it is what a total order
 * *is*. Sharding the counter would restore throughput and destroy the ordering
 * the counter exists to provide. So the honest design is to make it opt-in
 * (`envelope: { seq: true }`), pay the cost only where a delta cursor is
 * actually needed, and say the number out loud rather than let somebody
 * discover it under load.
 *
 * An append-only event log with one writer — virta's case, and the case this
 * was asked for — is comfortably inside it. A bulk import is not.
 *
 * ## Not in COLLECTIONS
 *
 * `system:seq` is unregistered, so deny-default makes the counters unreachable
 * through `/doc` for everyone including owner. A counter an attacker can rewind
 * is a counter that makes replicas skip events.
 */

import * as admin from 'firebase-admin'

export const SEQ_COLLECTION = 'system:seq'

/**
 * Commit `data` at `path` with the next `_seq` for `collection`.
 *
 * The counter read, the counter write and the document write are ONE
 * transaction. Split them and two concurrent writers can read the same value
 * and commit the same `_seq` — at which point a replica resuming from that
 * number skips one of them, which is precisely the failure this exists to
 * prevent.
 */
export async function commitWithSeq(
  collection: string,
  path: string,
  data: Record<string, unknown>,
  ref: FirebaseFirestore.DocumentReference
): Promise<number> {
  const db = admin.firestore()
  const counter = db.collection(SEQ_COLLECTION).doc(collection)

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(counter)
    // A missing counter starts at 0, so the first document is `_seq: 1` and a
    // client may use `since=0` to mean "everything from the beginning".
    const next = ((snapshot.data()?.value as number) ?? 0) + 1
    tx.set(counter, { value: next, at: new Date().toJSON() }, { merge: true })
    tx.set(ref, { ...data, _seq: next })
    return next
  })
}
