/**
 * The transactional write: every read, check and write of a commit in ONE
 * Firestore transaction.
 *
 * Extracted from `/docs` (#15) so `/doc` can use the same path for the
 * collections where a race is a correctness bug, not an inconvenience: an
 * `immutable` or sequenced collection (#1184). `/doc` used to read existence
 * OUTSIDE its commit, so two concurrent creates of one new id both saw
 * "missing" and both committed, and the second re-sequenced the first — for an
 * immutable log, exactly the corruption `immutable` exists to prevent.
 *
 * ## The transaction's shape is the whole design
 *
 * Firestore requires every READ in a transaction to precede every WRITE. The
 * pipeline reads (the stored document, and `isUnique`'s query), so every
 * pipeline runs first, to completion, and only then is anything written.
 *
 * Returns an outcome rather than writing a response: the endpoints differ in
 * how they answer, never in what they decide.
 */
import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import { collectionPath, type CollectionMap } from './collections/access'
import type { UserRoles } from './collections/roles'
import { runWritePipeline, type WriteMethod } from './collections/write-pipeline'
import { BatchUniqueClaims } from './collections/write-set'
import { SEQ_COLLECTION } from './collections/sequence'
import { physicalPath } from './collections/namespace'

export interface TransactionalWrite {
  p: string
  method?: WriteMethod
  data: Record<string, unknown>
}

export interface Refusal {
  p: string
  reason: string
  message: string
  details?: unknown
}

export type CommitOutcome =
  | {
      status: 'committed'
      /** What was written, in order; a no-op is absent. */
      out: Array<{ p: string; seq?: number }>
    }
  | { status: 'refused'; refusal: Refusal }

/**
 * Commit `writes` atomically — all or nothing — and run each committed
 * collection's `afterWrite` after the commit. Throws only for an unexpected
 * failure (the caller answers 500); every decision is an outcome.
 */
export async function commitTransactionally(
  writes: TransactionalWrite[],
  collections: CollectionMap,
  userRoles: UserRoles
): Promise<CommitOutcome> {
  const db = admin.firestore()
  const now = new Date().toJSON()
  let results: {
    out: Array<{ p: string; seq?: number }>
    committed: Array<{ w: TransactionalWrite; data: Record<string, unknown>; before?: Record<string, unknown> }>
  }
  try {
    results = await db.runTransaction(async (tx) => {
      const prepared: Array<{
        w: (typeof writes)[number]
        ref: FirebaseFirestore.DocumentReference
        data: Record<string, unknown>
        before?: Record<string, unknown>
      }> = []

      // ── PHASE 1: every read. ────────────────────────────────────────────
      const claims = new BatchUniqueClaims()
      for (const w of writes) {
        const ref = admin.firestore().doc(physicalPath(w.p))
        const snapshot = await tx.get(ref)
        const config = collections[collectionPath(w.p)]
        // UPSERT when no method was named: dispatch on the existence we just
        // read, so a first push creates and a retry is a free no-op. Naming a
        // method keeps the strict guard — POST asserts "not yet", PUT asserts
        // "already" — which is worth being able to say, just not by default in
        // a batch where the caller usually cannot know.
        const method = (w.method ?? (snapshot.exists ? 'PUT' : 'POST')) as WriteMethod
        const outcome = await runWritePipeline(
          {
            method,
            body: w.data,
            existing: snapshot.data() ?? {},
            exists: snapshot.exists,
            config,
            userRoles,
          },
          {
            now: () => now,
            // Uniqueness inside the transaction, so a concurrent writer
            // cannot slip a colliding document in between the check and the
            // commit — the exact race a batch makes more likely.
            isUnique: async (field, value) => {
              // The document's PARENT collection path, as /doc uses — not the
              // logical `collectionPath`, which for a sub-collection
              // (`post/comment`) is not a Firestore collection path at all.
              const parent = physicalPath(w.p).split('/').slice(0, -1).join('/')
              const found = await tx.get(
                admin
                  .firestore()
                  .collection(parent)
                  .where(field, '==', value)
                  .limit(2)
              )
              return found.docs.every((d) => d.ref.path === ref.path)
            },
          }
        )

        if (outcome.status === 'rejected') {
          // Thrown, not returned: the transaction must not commit a partial
          // set, and naming the document is safe here because the access gate
          // above has already passed.
          throw Object.assign(new Error(outcome.message), {
            refusal: { p: w.p, reason: outcome.reason, message: outcome.message,
              details: (outcome as { details?: unknown }).details },
          })
        }
        if (outcome.status === 'noop') continue
        // Uniqueness WITHIN the batch: the store check above cannot see this
        // transaction's own pending writes (0.2.0 re-review, M1).
        const repeated = claims.claim(physicalPath(w.p), config?.unique ?? [], outcome.data)
        if (repeated) {
          throw Object.assign(new Error(`"${repeated}" is claimed twice in this commit`), {
            refusal: {
              p: w.p,
              reason: 'unique',
              message: `"${repeated}" is required to exist and be unique — another write in this commit already uses that value`,
            },
          })
        }
        prepared.push({ w, ref, data: outcome.data, before: snapshot.exists ? snapshot.data() : undefined })
      }

      // Sequenced collections take a CONTIGUOUS range from ONE counter read,
      // so a replica never observes a torn commit: either every document in it
      // is at or below the cursor, or none is.
      const counters = new Map<string, { ref: FirebaseFirestore.DocumentReference; next: number }>()
      for (const { w } of prepared) {
        const cp = collectionPath(w.p)
        if (!collections[cp]?.seq || counters.has(cp)) continue
        const ref = admin.firestore().collection(SEQ_COLLECTION).doc(cp)
        const snapshot = await tx.get(ref)
        counters.set(cp, { ref, next: ((snapshot.data()?.value as number) ?? 0) + 1 })
      }

      // ── PHASE 2: every write. ───────────────────────────────────────────
      const out: Array<{ p: string; seq?: number }> = []
      for (const { w, ref, data } of prepared) {
        const cp = collectionPath(w.p)
        const counter = counters.get(cp)
        if (counter) {
          const seq = counter.next++
          tx.set(ref, { ...data, _seq: seq })
          out.push({ p: w.p, seq })
        } else {
          tx.set(ref, data)
          out.push({ p: w.p })
        }
      }
      for (const { ref, next } of counters.values()) {
        tx.set(ref, { value: next - 1, at: now }, { merge: true })
      }
      return { out, committed: prepared }
    })
  } catch (e) {
    const refusal = (e as { refusal?: Refusal }).refusal
    if (refusal) return { status: 'refused', refusal }
    throw e
  }

    // Post-commit side effects, exactly as /doc runs them (0.2.0 review): a
    // `post` committed through a batch otherwise left the blog cache stale for
    // up to a day — the very bug `afterWrite` exists to fix. After the commit,
    // never inside the transaction (which may retry); failures are logged,
    // never surfaced, because the writes have already landed.
    for (const { w, data, before } of results.committed) {
      const config = collections[collectionPath(w.p)]
      if (!config?.afterWrite) continue
      try {
        await config.afterWrite(data, userRoles, { path: w.p, before, after: data })
      } catch (e) {
        functions.logger.warn(`afterWrite failed for ${w.p}:`, e)
      }
    }

    return { status: 'committed', out: results.out }
}
