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


export const SEQ_COLLECTION = 'system:seq'

/*
 * Assigning the sequence lives in `commit.ts` (commitTransactionally): one
 * transaction reads the counter, runs every write's pipeline, and writes the
 * documents with a CONTIGUOUS range — for /docs batches and, since #1184, for
 * single /doc writes to a sequenced collection too. A separate single-write
 * helper here re-read neither the document nor uniqueness inside its
 * transaction, which is how a concurrent create could re-sequence a log.
 */
