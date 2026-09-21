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
  opaqueStatus,
  type CollectionMap,
} from './collections/access'
import { COLLECTIONS } from './collections'
import { collectionsFor } from './install/installed'
import { getRef } from './doc'
import { Response } from 'express'

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
  filter?: (rec: Record<string, unknown>) => Promise<Error | Record<string, unknown>>,
  /** Configs to resolve `field=value` against — see getRef in doc.ts. */
  collections: CollectionMap = COLLECTIONS
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
  limit: number
): Promise<{ rows: Record<string, unknown>[]; cursor: number; more: boolean }> {
  const ref = await getRef(path, true)
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

export const docs = onRequest({}, async (req, res) => {
  if (optionsResponse(req, res, ['GET'])) {
    return
  }

  const path = req.query.p as string
  const limit = Number(req.query.c) || 10
  const fields = req.query.f ? (req.query.f as string).split(',') : false
  const userRoles = await getUserRoles(req)
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
      res.status(400).json({
        error: 'not-sequenced',
        message:
          `"${collectionPath(path)}" does not assign _seq; ` +
          'declare `envelope: { seq: true }` in its manifest to replicate it',
      })
      return
    }
    const delta = await sequencedDelta(path, Number(since) || 0, limit)
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
    res.status(opaqueStatus(userRoles, 403)).send()
  }
})
