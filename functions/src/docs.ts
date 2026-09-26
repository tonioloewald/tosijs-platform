/**
# /docs endpoint

## Required Parameters

- `p` (path) to collection

## Optional Parameters

- `c` (count) limits the number of records returned (default is 10)
- `f` (fields) comma-delimited list of fields to be returned
- `o` (order) is the sort field, e.g. `date` or `date(desc)`

## TODO
- `q` (query) a comma-delimited list of queries; will return a
  useful error if a required index is missing
*/

import { onRequest } from 'firebase-functions/v2/https'
import * as functions from 'firebase-functions'
import compression from 'compression'

import {
  optionsResponse,
  getUserRoles,
  AuthenticatedRequest,
} from './utilities'
import {
  collectionPath,
  getMethodAccess,
  ALL,
  hasPrivilegedRole,
  type CollectionMap,
} from './collections/access'
import { collectionsFor } from './install/installed'
import { getRef } from './doc'
import { Response } from 'express'
import * as admin from 'firebase-admin'
import { runWritePipeline, type WriteMethod } from './collections/write-pipeline'
import { validateWriteSet } from './collections/write-set'
import { SEQ_COLLECTION } from './collections/sequence'
import { physicalPath } from './collections/namespace'
import {
  fail,
  notFound,
  noStore,
  rejectionStatus,
  type RejectionReason,
} from './errors'

const compressResponse = compression()

/**
 * Hard bound on how many documents a filtered query will scan.
 *
 * Filtering happens BEFORE the limit (see below), so a highly selective
 * predicate over a large collection could otherwise read the whole thing. This
 * is a safety bound, not an optimisation: exceeding it is reported rather than
 * silently truncating, because "we stopped looking" and "there is nothing more"
 * must not look the same.
 */
const MAX_FILTER_SCAN = 2000

export async function getRecords(
  path: string,
  limit: number,
  order = '',
  fields = false as string[] | false,
  /**
   * Row-visibility filter, applied to the FULL document. Returns the record
   * (possibly narrowed) to keep it, or an Error to hide it — the AccessFilterFunc
   * contract.
   */
  filter:
    | ((rec: Record<string, unknown>) => Promise<Error | Record<string, unknown>>)
    | undefined,
  /** Configs to resolve `field=value` against — REQUIRED; see getRef in doc.ts. */
  collections: CollectionMap
): Promise<Record<string, unknown>[]> {
  const refResult = await getRef(path, true, collections)
  if (refResult instanceof Error) {
    return []
  }
  let ref = refResult as FirebaseFirestore.Query
  const [, field, direction] = order.match(/^(\w+)(\(asc\)|\(desc\))?$/) || [
    '',
    '',
  ]

  if (field) {
    ref = ref.orderBy(field, direction !== '(desc)' ? 'asc' : 'desc')
  }

  const baseCollectionPath = collectionPath(path)
  const toRecord = (doc: FirebaseFirestore.QueryDocumentSnapshot) => ({
    ...doc.data(),
    _path: baseCollectionPath + '/' + doc.id,
  })

  // ── Unfiltered: the limit IS the answer, so let Firestore do it. ──────────
  if (!filter) {
    const q = ref.limit(limit)
    const snapshot = await (fields ? q.select(...fields).get() : q.get())
    return snapshot.empty ? [] : snapshot.docs.map(toRecord)
  }

  // ── Filtered: FILTER BEFORE LIMIT. ───────────────────────────────────────
  //
  // This used to apply `.limit(n)` and let the caller drop rows afterwards, so a
  // request for 10 published posts could return 3 while 50 existed — the limit
  // was consumed by rows the caller was never allowed to see. Asking for n and
  // getting fewer, with more available, is simply a wrong answer; paging until
  // we have n visible rows is the right one. (Decision: Tonio, 2026-09-06 —
  // "filter before limit; insofar as that is a performance problem that's for
  // later. Assuming it isn't is premature optimization.")
  //
  // Note we deliberately do NOT `.select(...fields)` here: the projection would
  // strip the very fields the predicate reads (a `post` list projected to
  // `title,path` has no `date`, so every row would look unpublished), so the
  // filter must see the whole document and projection happens after.
  const kept: Record<string, unknown>[] = []
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined
  let scanned = 0
  const pageSize = Math.min(Math.max(limit, 50), 300)

  while (kept.length < limit && scanned < MAX_FILTER_SCAN) {
    const page = cursor ? ref.startAfter(cursor).limit(pageSize) : ref.limit(pageSize)
    const snapshot = await page.get()
    if (snapshot.empty) break
    scanned += snapshot.size
    cursor = snapshot.docs[snapshot.docs.length - 1]

    for (const doc of snapshot.docs) {
      const result = await filter(toRecord(doc))
      if (!(result instanceof Error)) {
        kept.push(result)
        if (kept.length === limit) break
      }
    }
    if (snapshot.size < pageSize) break // collection exhausted
  }

  if (kept.length < limit && scanned >= MAX_FILTER_SCAN) {
    functions.logger.warn('[docs] filter scan bound hit — result may be short', {
      path,
      limit,
      returned: kept.length,
      scanned,
      bound: MAX_FILTER_SCAN,
    })
  }

  // Projection AFTER filtering, so the predicate saw the whole document.
  if (!fields) return kept
  return kept.map((rec) => {
    const out: Record<string, unknown> = { _path: rec._path }
    for (const f of fields) if (f in rec) out[f] = rec[f]
    return out
  })
}

export const getDocs = async (
  req: AuthenticatedRequest,
  res: Response,
  path: string,
  limit = 10,
  fields: string[] | false = false,
  order = ''
): Promise<Record<string, unknown>[]> => {
  const userRoles = await getUserRoles(req)
  const collections = await collectionsFor(collectionPath(path))
  const access = getMethodAccess(
    collections,
    collectionPath(path),
    'LIST',
    userRoles,
    fields
  )

  if (access === ALL) {
    return await getRecords(path, limit, order, fields, undefined, collections)
  } else if (typeof access === 'function') {
    // Filter is applied INSIDE the query loop, before the limit — see getRecords.
    return await getRecords(
      path,
      limit,
      order,
      fields,
      (rec) => access(rec, userRoles),
      collections
    )
  } else {
    return []
  }
}

/**
 * The delta query (#14): every document with `_seq > since`, in `_seq` order.
 *
 * Separate from `getRecords` because that appends `orderBy('_created desc')`
 * unconditionally, which is the wrong order here and would need a composite
 * index besides. A single-field ascending order on `_seq` uses the automatic
 * index, so a consumer needs no index deploy to start replicating.
 *
 * `more` is returned rather than left to the client to infer. A server may cap
 * `c` below what was asked, so a short page does NOT mean the last page — and
 * a client that assumes it does stops replicating early and silently. That is
 * the same class of bug as a filtered query truncating at its limit (D7).
 */
async function sequencedDelta(
  path: string,
  since: number,
  limit: number,
  collections: CollectionMap
): Promise<{ rows: Record<string, unknown>[]; cursor: number; more: boolean }> {
  const ref = await getRef(path, true, collections)
  if (ref instanceof Error) return { rows: [], cursor: since, more: false }
  // One extra row, purely to answer `more` honestly without a second query.
  const snapshot = await (ref as FirebaseFirestore.Query)
    .where('_seq', '>', since)
    .orderBy('_seq', 'asc')
    .limit(limit + 1)
    .get()
  const docs = snapshot.docs.slice(0, limit)
  const rows: Record<string, unknown>[] = docs.map((d) => ({
    ...d.data(),
    _id: d.id,
  }))
  return {
    rows,
    cursor: rows.length
      ? (rows[rows.length - 1]._seq as number)
      : since,
    more: snapshot.docs.length > limit,
  }
}

/**
 * Commit several documents atomically (#15).
 *
 * ## The transaction's shape is the whole design
 *
 * Firestore requires every READ in a transaction to precede every WRITE. The
 * write pipeline reads — it needs the stored document for its existence guard
 * and no-op check, and it calls `isUnique`, which is a query. So the pipelines
 * all run first, to completion, and only then is anything written. Interleaving
 * them would look correct and fail the moment a batch contained two documents.
 *
 * ## Why all-or-nothing matters here specifically
 *
 * A retry heals the documents that did not land. It does not heal the readers
 * who saw a half-applied commit in between — which for a folded event log is a
 * state that never legally existed.
 */
async function commitWriteSet(
  req: AuthenticatedRequest,
  res: Response,
  collections: CollectionMap,
  userRoles: Awaited<ReturnType<typeof getUserRoles>>
): Promise<void> {
  const decision = validateWriteSet(req.body)
  if (decision.status === 'refused') {
    fail(res, 400, 'refused', 'the write set was refused', {
      problems: decision.problems,
    })
    return
  }
  const writes = decision.writes

  // Authorization over the WHOLE SET, before anything is read or written. A
  // commit that is atomic in its writes but not in its access checks would let
  // a caller learn which of several collections they may write by watching
  // which request failed.
  for (const w of writes) {
    const cp = collectionPath(w.p)
    // POST/PUT/PATCH all map to the same `write` access type, so the answer
    // does not depend on which — but it must be A method: an unnamed upsert
    // passed through as `undefined` resolves to no access type at all, and
    // every commit is denied.
    const access = getMethodAccess(
      collections,
      cp,
      (w.method ?? 'PUT') as never,
      userRoles
    )
    if (access === undefined) {
      // Opaque, matching /doc: the caller learns the commit failed, not which
      // collection they were not allowed to touch.
      if (hasPrivilegedRole(userRoles)) {
        fail(res, 403, 'forbidden', 'forbidden')
      } else {
        notFound(res)
      }
      return
    }
  }

  const db = admin.firestore()
  const now = new Date().toJSON()

  try {
    const results = await db.runTransaction(async (tx) => {
      const prepared: Array<{
        w: (typeof writes)[number]
        ref: FirebaseFirestore.DocumentReference
        data: Record<string, unknown>
      }> = []

      // ── PHASE 1: every read. ────────────────────────────────────────────
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
        prepared.push({ w, ref, data: outcome.data })
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

    // Post-commit side effects, exactly as /doc runs them (0.2.0 review): a
    // `post` committed through a batch otherwise left the blog cache stale for
    // up to a day — the very bug `afterWrite` exists to fix. After the commit,
    // never inside the transaction (which may retry); failures are logged,
    // never surfaced, because the writes have already landed.
    for (const { w, data } of results.committed) {
      const config = collections[collectionPath(w.p)]
      if (!config?.afterWrite) continue
      try {
        await config.afterWrite(data, userRoles)
      } catch (e) {
        functions.logger.warn(`afterWrite failed for ${w.p}:`, e)
      }
    }

    res.json({
      status: 'committed',
      written: results.out.length,
      results: results.out,
    })
  } catch (e) {
    const refusal = (e as { refusal?: Record<string, unknown> }).refusal
    if (refusal) {
      fail(
        res,
        rejectionStatus(refusal.reason as RejectionReason),
        refusal.reason as never,
        refusal.message as string,
        {
          p: refusal.p,
          ...(refusal.details ? { details: refusal.details } : {}),
          note: 'nothing was written — a commit is all or nothing',
        }
      )
      return
    }
    functions.logger.error('batch commit failed', e)
    fail(res, 500, 'internal', 'commit failed')
  }
}

export const docs = onRequest({}, async (req, res) => {
  // A platform API response is about the caller who asked — never shared
  // by a CDN (#27). Set FIRST, so it also covers an uncaught throw and the
  // rate-limit / method refusals inside optionsResponse. A handler that is
  // genuinely public may override it.
  noStore(res)
  if (optionsResponse(req, res, ['GET', 'POST'])) {
    return
  }

  const userRoles = await getUserRoles(req)

  // POST /docs is the ATOMIC multi-document commit (#15). It shares this
  // route because it is the plural-document endpoint; a separate function
  // would need its own invoker binding, which is a documented footgun.
  if (req.method === 'POST') {
    const paths = Array.isArray(req.body?.writes)
      ? (req.body.writes as Array<{ p?: string }>).map((w) => String(w?.p ?? ''))
      : []
    // Resolve the collection map over EVERY collection the commit touches, not
    // just the first — a batch may legitimately span two installed libraries.
    const maps = await Promise.all(
      [...new Set(paths.map((p) => collectionPath(p)))].map((c) =>
        collectionsFor(c)
      )
    )
    const merged: CollectionMap = Object.assign({}, ...maps)
    await commitWriteSet(req as AuthenticatedRequest, res, merged, userRoles)
    return
  }

  const path = req.query.p as string
  const limit = Number(req.query.c) || 10
  const fields = req.query.f ? (req.query.f as string).split(',') : false
  const order = (req.query.o as string) || ''
  // const query = req.body.q as string
  const collections = await collectionsFor(collectionPath(path))
  const access = getMethodAccess(
    collections,
    collectionPath(path),
    'LIST',
    userRoles,
    fields
  )

  // The delta cursor (#14). Only for a collection that is actually sequenced —
  // otherwise `_seq > since` silently matches nothing, and "no new events" and
  // "this collection has no sequence" would look identical to a replica.
  const since = req.query.since
  if (since !== undefined && access !== undefined) {
    const config = collections[collectionPath(path)]
    if (!config?.seq) {
      fail(res, 400, 'not-sequenced',
          `"${collectionPath(path)}" does not assign _seq; ` +
          'declare `envelope: { seq: true }` in its manifest to replicate it')
      return
    }
    const delta = await sequencedDelta(path, Number(since) || 0, limit, collections)
    // Row visibility still applies — a delta must not become a way around the
    // filter a plain LIST would have run.
    const rows =
      access === ALL
        ? delta.rows
        : (
            await Promise.all(
              delta.rows.map(async (row) =>
                (await access(row, userRoles)) instanceof Error ? null : row
              )
            )
          ).filter(Boolean)
    compressResponse(req, res, () => {
      res.json({ rows, cursor: delta.cursor, more: delta.more })
    })
    return
  }

  if (access === ALL) {
    const found = await getRecords(
      path,
      limit,
      order,
      fields,
      undefined,
      collections
    )
    compressResponse(req, res, () => {
      res.json(found)
    })
  } else if (typeof access === 'function') {
    // Same filter-before-limit path as getDocs — this handler had its own copy
    // of the post-filter, so fixing only one call site would have left the HTTP
    // endpoint returning short pages.
    const found = await getRecords(
      path,
      limit,
      order,
      fields,
      (rec) => access(rec, userRoles),
      collections
    )
    compressResponse(req, res, () => {
      res.json(found)
    })
  } else {
    // Opaque denial, matching `/doc`. A 403 here confirms the collection exists,
    // which defeats the point of `/doc` answering 404 for the same resource:
    // GET role/owner-role hid the collection while LIST role announced it.
    // Privileged callers (admin/developer/owner) still get the real 403.
    if (hasPrivilegedRole(userRoles)) {
      fail(res, 403, 'forbidden', 'forbidden')
    } else {
      notFound(res)
    }
  }
})
