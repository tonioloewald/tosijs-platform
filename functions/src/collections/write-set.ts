/**
 * Multi-document writes (#15) — the pure half.
 *
 * One user action in a consumer is usually several documents: virta's
 * cross-project move is untag + tag + tag + comment. Committed one request at
 * a time, a failure after the second leaves a torn write — and a retry heals
 * the missing documents but not the readers who saw the tear.
 *
 * So: all or nothing. This file decides what a write set must satisfy before
 * any I/O happens; `docs.ts` runs it inside one Firestore transaction.
 */

export type WriteMethodName = 'POST' | 'PUT' | 'PATCH'

export interface WriteRequest {
  p: string
  data: Record<string, unknown>
  /**
   * Absent means UPSERT: create if the document is not there, replace it if it
   * is, and no-op if the content is identical.
   *
   * That is the shape an idempotent append needs, and neither strict method
   * provides it — POST refuses an existing document, PUT refuses a missing
   * one. A consumer pushing events under client-generated ids wants a retry
   * to be free and a first write to succeed, which is precisely upsert.
   *
   * Naming a method instead opts into the strict guard: POST means "this must
   * not exist yet", PUT means "this must exist". Those are assertions worth
   * being able to make, so they stay available — they are just not the default
   * for a batch, where the caller usually cannot know.
   */
  method?: WriteMethodName
}

/**
 * How many documents one commit may carry.
 *
 * Bounded because a transaction holds locks for its duration and every
 * document in it is a read plus a write. Firestore's own ceiling is higher;
 * this is lower on purpose, so a batch that is really a bulk import fails
 * fast and obviously rather than by timing out under contention.
 */
export const MAX_WRITES = 100

const METHODS: WriteMethodName[] = ['POST', 'PUT', 'PATCH']

export type WriteSetDecision =
  | { status: 'ok'; writes: WriteRequest[] }
  | { status: 'refused'; problems: string[] }

/**
 * Validate the shape of a write set.
 *
 * DELETE is absent deliberately. A mixed commit of writes and deletes has a
 * meaningful ordering question inside it — does a delete of a document another
 * write in the same set creates win? — and guessing an answer is worse than
 * refusing one. Deletes stay single-document until somebody needs otherwise
 * and says what they expect.
 */
export function validateWriteSet(input: unknown): WriteSetDecision {
  const problems: string[] = []
  const fail = (m: string) => problems.push(m)

  const raw = (input as { writes?: unknown })?.writes
  if (!Array.isArray(raw)) {
    return { status: 'refused', problems: ['expected { writes: [...] }'] }
  }
  if (raw.length === 0) {
    return { status: 'refused', problems: ['"writes" is empty'] }
  }
  if (raw.length > MAX_WRITES) {
    return {
      status: 'refused',
      problems: [`"writes" holds ${raw.length}; the limit is ${MAX_WRITES}`],
    }
  }

  const seen = new Set<string>()
  const writes: WriteRequest[] = []

  raw.forEach((entry, i) => {
    const w = entry as Record<string, unknown>
    const where = `writes[${i}]`
    if (w === null || typeof w !== 'object') {
      fail(`${where}: must be an object`)
      return
    }
    if (typeof w.p !== 'string' || !w.p) {
      fail(`${where}.p: required`)
      return
    }
    if (w.p.split('/').length % 2 !== 0) {
      fail(`${where}.p: "${w.p}" is not a document path`)
      return
    }
    // Two writes to one document in a single commit cannot both be evaluated
    // against "the document as it exists": the second would be judged against
    // state the first has not written yet, so its existence guard and its
    // no-op check would both be answering about the wrong document.
    if (seen.has(w.p)) {
      fail(`${where}.p: "${w.p}" appears twice in one commit`)
      return
    }
    seen.add(w.p)

    if (w.data === null || typeof w.data !== 'object') {
      fail(`${where}.data: must be an object`)
      return
    }
    const method = w.method as WriteMethodName | undefined
    if (method !== undefined && !METHODS.includes(method)) {
      fail(
        `${where}.method: ${JSON.stringify(w.method)} — expected ` +
          `${METHODS.join(', ')} (DELETE is single-document only)`
      )
      return
    }
    writes.push({
      p: w.p,
      data: w.data as Record<string, unknown>,
      ...(method ? { method } : {}),
    })
  })

  if (problems.length) return { status: 'refused', problems }
  return { status: 'ok', writes }
}

/**
 * Group writes by collection, preserving order within each group.
 *
 * Sequenced collections take a CONTIGUOUS range from one counter read, so a
 * replica never observes a torn commit: either every document in it is at or
 * below the replica's cursor, or none is.
 */
export function byCollection(
  writes: WriteRequest[],
  collectionOf: (path: string) => string
): Map<string, WriteRequest[]> {
  const groups = new Map<string, WriteRequest[]>()
  for (const w of writes) {
    const key = collectionOf(w.p)
    const group = groups.get(key)
    if (group) group.push(w)
    else groups.set(key, [w])
  }
  return groups
}

/**
 * Tracks the `unique` values claimed by earlier writes in ONE batch.
 *
 * A batch checks uniqueness against committed state (`tx.get`), and a
 * Firestore transaction cannot see its own buffered writes — so two writes in
 * the same batch carrying the same unique value both passed, and both
 * committed, silently (0.2.0 re-review, M1). `/doc` cannot hit this: it writes
 * one document. Pure, so it is tested without a store.
 *
 * Keyed by the document's PARENT collection path, field and value — the same
 * scope the store-side check uses — so `post/a` and `post/b` collide on
 * `path=x`, while two different sub-collections do not.
 */
export class BatchUniqueClaims {
  private readonly claimed = new Map<string, string>()

  /**
   * Record `docPath`'s values for `fields`. Returns the first field whose value
   * an EARLIER write in this batch already claimed, or null.
   */
  claim(docPath: string, fields: readonly string[], data: Record<string, unknown>): string | null {
    const parent = docPath.split('/').slice(0, -1).join('/')
    const keys: Array<[string, string]> = []
    for (const field of fields) {
      const value = data[field]
      // Non-scalars never get here: the pipeline refuses them first.
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const key = `${parent}\u0000${field}\u0000${typeof value}:${value}`
      const holder = this.claimed.get(key)
      if (holder !== undefined && holder !== docPath) return field
      keys.push([key, docPath])
    }
    for (const [key, path] of keys) this.claimed.set(key, path)
    return null
  }
}
