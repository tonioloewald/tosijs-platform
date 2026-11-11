/**
# /docs endpoint

## Required Parameters

- `p` (path) to collection

## Optional Parameters

- `c` (count) limits the number of records returned (default is 10)
- `f` (fields) comma-delimited list of fields to be returned
- `o` (order) is the sort field, e.g. `date` or `date(desc)`
- `modifiedAfter` an ISO time: only documents edited after it, newest edit
  first (or `o=_modified(asc)`). Plain collection paths only, and no other
  order (Firestore would need a composite index). A convenience for polling;
  replication uses `since` (#4050)

## TODO
- `q` (query) a comma-delimited list of queries; will return a
  useful error if a required index is missing
*/

import type { Handler } from './http'
import { log } from './log'
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
import { storeFor } from './datastore'
import { listRecords, modifiedAfterQuery, sequencedDelta } from './collections/list'
import { Response } from 'express'
import { validateWriteSet } from './collections/write-set'
import { commitTransactionally } from './commit'
import {
  fail,
  notFound,
  noStore,
  rejectionStatus,
  type RejectionReason,
} from './errors'

const compressResponse = compression()

/**
 * List a collection, filter BEFORE limit (D7). The decision lives in the kernel
 * (`collections/list.ts`); this binds it to the Firestore store for the
 * request's collection map.
 */
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
  collections: CollectionMap,
  /** Only documents edited after this ISO time (#4050). */
  modifiedAfter?: string
): Promise<Record<string, unknown>[]> {
  return listRecords(storeFor(collections), path, {
    limit,
    order,
    fields,
    filter,
    collections,
    modifiedAfter,
    onScanBound: (detail) =>
      log.warn('[docs] filter scan bound hit — result may be short', detail),
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
    if (access !== undefined && collections[cp]?.blob) {
      fail(res, 403, 'refused', 'files in a storage area are written through /blob', { p: w.p })
      return
    }
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

  try {
    const outcome = await commitTransactionally(writes, collections, userRoles)
    if (outcome.status === 'refused') {
      const { refusal } = outcome
      fail(
        res,
        rejectionStatus(refusal.reason as RejectionReason),
        refusal.reason as never,
        refusal.message,
        {
          p: refusal.p,
          ...(refusal.details ? { details: refusal.details } : {}),
          note: 'nothing was written — a commit is all or nothing',
        }
      )
      return
    }
    res.json({
      status: 'committed',
      written: outcome.out.length,
      results: outcome.out,
    })
  } catch (e) {
    log.error('batch commit failed', e)
    fail(res, 500, 'internal', 'commit failed')
  }
}

export const handleDocs: Handler = async (req, res) => {
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
    const delta = await sequencedDelta(storeFor(collections), path, Number(since) || 0, limit, collections)
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

  const modifiedAfter = typeof req.query.modifiedAfter === 'string' ? req.query.modifiedAfter : undefined
  if (modifiedAfter !== undefined && access !== undefined) {
    const checked = modifiedAfterQuery(order, modifiedAfter)
    if (checked instanceof Error) {
      fail(res, 400, 'bad-request', checked.message)
      return
    }
    if (path.includes('=')) {
      fail(res, 400, 'bad-request', 'modifiedAfter lists a plain collection path, not a field=value filter')
      return
    }
  }

  if (access === ALL) {
    const found = await getRecords(
      path,
      limit,
      order,
      fields,
      undefined,
      collections,
      modifiedAfter
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
      collections,
      modifiedAfter
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
}
