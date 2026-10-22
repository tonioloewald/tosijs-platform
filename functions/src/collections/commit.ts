/**
 * The transactional write: every read, check and write of a commit in ONE
 * transaction, over the store port (SOVEREIGN-PLAN.md Phase 1).
 *
 * Moved from `commit.ts` (which is now the Firestore binding) unchanged in
 * what it decides. It serves `/docs` batches (#15) and `/doc` writes to the
 * collections where a race is a correctness bug: `immutable` or sequenced
 * (#1184). `/doc` used to read existence OUTSIDE its commit, so two concurrent
 * creates of one new id both saw "missing" and both committed, and the second
 * re-sequenced the first.
 *
 * ## The transaction's shape is the whole design
 *
 * Every READ precedes every WRITE (Firestore requires it; `Tx` enforces it).
 * The pipeline reads (the stored document, and the uniqueness query), so every
 * pipeline runs first, to completion, and only then is anything written. The
 * body has no side effects, because a store may retry it; `afterWrite` runs
 * after the commit.
 *
 * Returns an outcome rather than writing a response: the endpoints differ in
 * how they answer, never in what they decide.
 */
import { collectionPath, type CollectionMap } from './access'
import type { UserRoles } from './roles'
import { runWritePipeline, type WriteMethod } from './write-pipeline'
import { BatchUniqueClaims } from './write-set'
import { SEQ_COLLECTION } from './sequence'
import { physicalPath } from './namespace'
import type { Store } from './store'

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

export interface CommitDeps {
  /** One timestamp for the whole commit. */
  now?: () => string
  /** Where a failed `afterWrite` is reported; it never fails the commit. */
  warn?: (message: string, error: unknown) => void
}

const refuse = (refusal: Refusal) =>
  Object.assign(new Error(refusal.message), { refusal })

/**
 * Commit `writes` atomically — all or nothing — and run each committed
 * collection's `afterWrite` after the commit. Throws only for an unexpected
 * failure (the caller answers 500); every decision is an outcome.
 */
export async function commitWrites(
  store: Pick<Store, 'transaction'>,
  writes: TransactionalWrite[],
  collections: CollectionMap,
  userRoles: UserRoles,
  deps: CommitDeps = {}
): Promise<CommitOutcome> {
  const now = (deps.now ?? (() => new Date().toJSON()))()
  let results: {
    out: Array<{ p: string; seq?: number }>
    committed: Array<{ w: TransactionalWrite; data: Record<string, unknown>; before?: Record<string, unknown> }>
  }
  try {
    results = await store.transaction(async (tx) => {
      const prepared: Array<{
        w: TransactionalWrite
        data: Record<string, unknown>
        before?: Record<string, unknown>
      }> = []

      // ── PHASE 1: every read. ────────────────────────────────────────────
      const claims = new BatchUniqueClaims()
      for (const w of writes) {
        const snapshot = await tx.get(w.p)
        const config = collections[collectionPath(w.p)]
        // UPSERT when no method was named: dispatch on the existence we just
        // read, so a first push creates and a retry is a free no-op. Naming a
        // method keeps the strict guard — POST asserts "not yet", PUT asserts
        // "already".
        const method = (w.method ?? (snapshot.exists ? 'PUT' : 'POST')) as WriteMethod
        const outcome = await runWritePipeline(
          {
            method,
            body: w.data,
            existing: snapshot.data,
            exists: snapshot.exists,
            config,
            userRoles,
          },
          {
            now: () => now,
            // Uniqueness inside the transaction, so a concurrent writer cannot
            // slip a colliding document in between the check and the commit.
            // The document's PARENT collection path, as /doc uses — not the
            // logical `collectionPath`, which for a sub-collection
            // (`post/comment`) is not a collection path at all.
            isUnique: async (field, value) => {
              const parent = w.p.split('/').slice(0, -1).join('/')
              const found = await tx.query(parent, {
                equals: { field, value },
                orderBy: '~',
                limit: 2,
              })
              return found.every((d) => d.path === w.p)
            },
          }
        )

        if (outcome.status === 'rejected') {
          // Thrown, not returned: the transaction must not commit a partial
          // set, and naming the document is safe here because the access gate
          // has already passed.
          throw refuse({
            p: w.p,
            reason: outcome.reason,
            message: outcome.message,
            details: (outcome as { details?: unknown }).details,
          })
        }
        if (outcome.status === 'noop') continue
        // Uniqueness WITHIN the batch: the store check above cannot see this
        // transaction's own pending writes (0.2.0 re-review, M1).
        const repeated = claims.claim(physicalPath(w.p), config?.unique ?? [], outcome.data)
        if (repeated) {
          throw refuse({
            p: w.p,
            reason: 'unique',
            message: `"${repeated}" is required to exist and be unique — another write in this commit already uses that value`,
          })
        }
        prepared.push({ w, data: outcome.data, before: snapshot.exists ? snapshot.data : undefined })
      }

      // Sequenced collections take a CONTIGUOUS range from ONE counter read,
      // so a replica never observes a torn commit: either every document in it
      // is at or below the cursor, or none is.
      const counters = new Map<string, { path: string; next: number }>()
      for (const { w } of prepared) {
        const cp = collectionPath(w.p)
        if (!collections[cp]?.seq || counters.has(cp)) continue
        const path = `${SEQ_COLLECTION}/${cp}`
        const snapshot = await tx.get(path)
        counters.set(cp, { path, next: ((snapshot.data.value as number) ?? 0) + 1 })
      }

      // ── PHASE 2: every write. ───────────────────────────────────────────
      const out: Array<{ p: string; seq?: number }> = []
      for (const { w, data } of prepared) {
        const counter = counters.get(collectionPath(w.p))
        if (counter) {
          const seq = counter.next++
          tx.set(w.p, { ...data, _seq: seq })
          out.push({ p: w.p, seq })
        } else {
          tx.set(w.p, data)
          out.push({ p: w.p })
        }
      }
      for (const { path, next } of counters.values()) {
        tx.set(path, { value: next - 1, at: now }, { merge: true })
      }
      return { out, committed: prepared }
    })
  } catch (e) {
    const refusal = (e as { refusal?: Refusal }).refusal
    if (refusal) return { status: 'refused', refusal }
    throw e
  }

  // Post-commit side effects, exactly as /doc runs them (0.2.0 review): a
  // `post` committed through a batch otherwise left the blog cache stale. After
  // the commit, never inside the transaction (which may retry); failures are
  // reported, never surfaced, because the writes have already landed.
  for (const { w, data, before } of results.committed) {
    const config = collections[collectionPath(w.p)]
    if (!config?.afterWrite) continue
    try {
      await config.afterWrite(data, userRoles, { path: w.p, before, after: data })
    } catch (e) {
      deps.warn?.(`afterWrite failed for ${w.p}:`, e)
    }
  }

  return { status: 'committed', out: results.out }
}
