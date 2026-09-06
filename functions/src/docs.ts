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
} from './collections/access'
import { COLLECTIONS } from './collections'
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
  filter?: (rec: Record<string, unknown>) => Promise<Error | Record<string, unknown>>
): Promise<Record<string, unknown>[]> {
  const refResult = await getRef(path, true)
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
  const access = getMethodAccess(
    COLLECTIONS,
    collectionPath(path),
    'LIST',
    userRoles,
    fields
  )

  if (access === ALL) {
    return await getRecords(path, limit, order, fields)
  } else if (typeof access === 'function') {
    // Filter is applied INSIDE the query loop, before the limit — see getRecords.
    return await getRecords(path, limit, order, fields, (rec) =>
      access(rec, userRoles)
    )
  } else {
    return []
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
  const access = getMethodAccess(
    COLLECTIONS,
    collectionPath(path),
    'LIST',
    userRoles,
    fields
  )

  if (access === ALL) {
    const found = await getRecords(path, limit, order, fields)
    compressResponse(req, res, () => {
      res.json(found)
    })
  } else if (typeof access === 'function') {
    // Same filter-before-limit path as getDocs — this handler had its own copy
    // of the post-filter, so fixing only one call site would have left the HTTP
    // endpoint returning short pages.
    const found = await getRecords(path, limit, order, fields, (rec) =>
      access(rec, userRoles)
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
