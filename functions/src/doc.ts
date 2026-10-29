/**
# /doc endpoint

## parameters
- `p` (path) is the document path, `collection/id` or `collection/field=value`
- `data` is the document (or patch)

## methods
- `GET` obtains the current version of the document at `p`
- `POST` | `PUT` | `PATCH` creates or updates the document at `p` with `data`
- `DELETE` removes the document at `p`
*/

import type { Handler } from './http'
import compression from 'compression'

import { log } from './log'
import {
  optionsResponse,
  getUserRoles,
  AuthenticatedRequest,
} from './utilities'
import { Response } from 'express'
import {
  collectionPath,
  documentPath,
  getMethodAccess,
  REST_METHOD,
  ALL,
  hasPrivilegedRole,
  opaqueStatus,
} from './collections/access'
import { collectionsFor } from './install/installed'
import { UserRoles } from './collections/roles'
import {
  runWritePipeline,
  type WriteMethod,
} from './collections/write-pipeline'
import { firestoreStoreFor as storeFor } from './adapters/firebase/firestore-store'
export { storeFor }
import {
  fail,
  notFound,
  noStore,
  rejectionStatus,
  type RejectionReason,
} from './errors'
import { commitTransactionally, type CommitOutcome } from './commit'

// Schema validation moved into `runWritePipeline` at the 2026-09-16 cutover —
// including the `strict: true` flag that stops tosijs-schema stride-sampling
// long arrays. See the note on that call in write-pipeline.ts.

const compressResponse = compression()

// TTL cache for documents with cacheLatencySeconds configured
// Uses LRU eviction with a max size to prevent unbounded memory growth
interface CacheEntry {
  data: any
  expiry: number
  lastAccess: number
}

const MAX_CACHE_ENTRIES = 100 // Max cached documents per function instance
const docCache = new Map<string, CacheEntry>()

// Evict oldest entries when cache is full (LRU)
function evictOldestCacheEntries(): void {
  if (docCache.size <= MAX_CACHE_ENTRIES) return

  // Sort by lastAccess and remove oldest entries
  const entries = Array.from(docCache.entries())
  entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess)

  // Remove oldest 20% to avoid frequent evictions
  const removeCount = Math.ceil(MAX_CACHE_ENTRIES * 0.2)
  for (let i = 0; i < removeCount && i < entries.length; i++) {
    docCache.delete(entries[i][0])
  }
}

export type DocResult =
  | { ok: true; data: any }
  | { ok: false; reason: string; status: number }

const opaqueError = (
  userRoles: UserRoles,
  reason: string,
  status: number
): DocResult => ({
  ok: false,
  // Only show detailed error messages to admin/developer/owner roles
  reason: hasPrivilegedRole(userRoles) ? reason : 'not found',
  status: opaqueStatus(userRoles, status),
})

export const getDoc = async (
  req: AuthenticatedRequest,
  res: Response,
  path: string,
  /**
   * `noCache`: read through to Firestore, and do not populate the per-instance
   * cache. Render on store needs it: that cache is never invalidated by writes,
   * so a recompute right after a write could read (and store) pre-write data.
   */
  opts: { noCache?: boolean } = {}
): Promise<DocResult> => {
  const userRoles = await getUserRoles(req)

  try {
    const _collectionPath = collectionPath(path)
    const collections = await collectionsFor(_collectionPath)
    const config = collections[_collectionPath]
    const access = getMethodAccess(
      collections,
      _collectionPath,
      req.method as REST_METHOD,
      userRoles
    )

    if (!access) {
      return opaqueError(userRoles, 'access denied', 403)
    }

    // Check cache if cacheLatencySeconds is configured
    const cacheSeconds = opts.noCache ? undefined : config?.cacheLatencySeconds
    if (cacheSeconds) {
      const cached = docCache.get(path)
      if (cached && cached.expiry > Date.now()) {
        // Update last access time for LRU
        cached.lastAccess = Date.now()
        return { ok: true, data: cached.data }
      }
    }

    const store = storeFor(collections)
    const canonicalPath = await store.resolve(path)
    if (canonicalPath instanceof Error) {
      return opaqueError(userRoles, canonicalPath.message, 404)
    }

    const doc = await store.get(canonicalPath)
    if (!doc.exists) {
      return { ok: false, reason: 'not found', status: 404 }
    }

    let data = doc.data as Record<string, unknown> | undefined
    const _path = documentPath(path, canonicalPath.split('/').pop() as string)
    if (access === ALL) {
      data = { ...data, _path }
    } else if (typeof access === 'function') {
      const filtered = await access(data, userRoles)
      if (filtered instanceof Error) {
        return opaqueError(userRoles, filtered.message, 403)
      }
      data = { ...filtered, _path }
    }

    // Store in cache if cacheLatencySeconds is configured
    if (cacheSeconds) {
      evictOldestCacheEntries()
      const now = Date.now()
      docCache.set(path, {
        data,
        expiry: now + cacheSeconds * 1000,
        lastAccess: now,
      })
    }

    return { ok: true, data }
  } catch (error) {
    return opaqueError(userRoles, 'internal error', 500)
  }
}

// Legacy wrapper for backwards compatibility - returns data or undefined
export const getDocData = async (
  req: AuthenticatedRequest,
  res: Response,
  path: string
): Promise<Record<string, unknown> | undefined> => {
  const result = await getDoc(req, res, path)
  return result.ok ? result.data : undefined
}

export const handleDoc: Handler = async (req, res) => {
  // A platform API response is about the caller who asked — never shared
  // by a CDN (#27). Set FIRST, so it also covers an uncaught throw and the
  // rate-limit / method refusals inside optionsResponse. A handler that is
  // genuinely public may override it.
  noStore(res)
  if (optionsResponse(req, res, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])) {
    return
  }
  const userRoles = await getUserRoles(req)

  const path = req.method.match(/GET|DELETE/) ? req.query.p : req.body.p

  if (!path) {
    fail(res, 400, 'bad-request', 'missing path')
    return
  }

  const pathParts = path.split('/')

  if (pathParts.length % 2 !== 0) {
    fail(res, 400, 'bad-request', 'bad path')
    return
  }

  const _collectionPath = collectionPath(path)
  const collections = await collectionsFor(_collectionPath)
  const config = collections[_collectionPath]

  if (!config) {
    notFound(res)
    return
  }

  const access = getMethodAccess(
    collections,
    _collectionPath,
    req.method as REST_METHOD,
    userRoles
  )

  if (!access) {
    // Opaque denial: non-privileged callers get 404 so a protected resource is
    // indistinguishable from a missing one (matches getDoc/opaqueError). Only
    // admin/developer/owner see the real 403.
    if (hasPrivilegedRole(userRoles)) {
      fail(res, 403, 'forbidden', 'forbidden')
    } else {
      notFound(res)
    }
    return
  }

  // SUBSTRATE PORT (tosijs-platform#7): mutations go through `Store`, not
  // Firestore. `resolve` canonicalizes `collection/field=value` to
  // `collection/id` once, so the round-trip count is unchanged and every later
  // call takes an unambiguous path.
  //
  // GET reads through the same store (its second `getRef` used to repeat the
  // `field=value` query that `resolve` had just answered).
  const store = storeFor(collections)
  const canonicalPath = await store.resolve(path)
  if (canonicalPath instanceof Error) {
    notFound(res)
    return
  }
  const doc = await store.get(canonicalPath)

  switch (req.method) {
    case 'GET':
      if (doc.exists) {
        let data = doc.data as Record<string, unknown> | undefined
        // The document's own path, never the lookup (see documentPath).
        if (access === ALL) {
          data = { ...data, _path: canonicalPath }
        } else if (typeof access === 'function') {
          const filtered = await access(data, userRoles)
          data = { ...filtered, _path: canonicalPath }
        }
        compressResponse(req, res, () => {
          res.json(data)
        })
        // this is exhaustive!
      } else {
        notFound(res)
      }
      return

    case 'DELETE':
      if (doc.exists && access === ALL && config.blob) {
        // Deleting the metadata alone would orphan the file's bytes (#1136).
        fail(res, 403, 'refused', 'files in a storage area are deleted through /blob')
      } else if (doc.exists && access === ALL && config.immutable) {
        // An immutable collection refuses deletes too (0.2.0-beta.3 review,
        // M3). Refusing only rewrites would leave delete-then-recreate, which
        // lands the same id with a FRESH `_seq` — exactly the re-sequencing
        // `immutable` exists to prevent — and a replica never hears about a
        // delete through `since=` anyway. Removal (a legal takedown, say) is
        // an owner acting on the datastore, not a request through `/doc`.
        // Reached only after the access gate, so naming the reason discloses
        // nothing the caller could not already learn.
        fail(
          res,
          409,
          'immutable',
          'this collection is immutable: a stored document cannot be deleted'
        )
      } else if (doc.exists && access === ALL) {
        try {
          const deleted = doc.data as Record<string, unknown>
          await store.delete(canonicalPath)
          // A delete mutates the collection exactly as a write does, so it must
          // invalidate the same caches. Omitting this was the original bug's twin:
          // edits were fixed while deleting a post still served it for up to 24h.
          if (config.afterWrite) {
            try {
              await config.afterWrite(deleted, userRoles, { path: canonicalPath, before: deleted })
            } catch (e) {
              log.warn(`afterWrite failed for ${path}:`, e)
            }
          }
          res.status(200).send('')
        } catch (e) {
          log.error(`Error deleting ${path}:`, e)
          fail(res, 500, 'internal', 'delete failed')
        }
      } else {
        // Opaque for a non-privileged caller; the path is not echoed back
        // either way.
        if (hasPrivilegedRole(userRoles)) {
          fail(res, 403, 'missing', 'no such document')
        } else {
          notFound(res)
        }
      }
      break
    case 'POST':
    case 'PUT':
    case 'PATCH': {
      // CUT OVER to the extracted pipeline (ROADMAP Phase 1 rung 1, 2026-09-16).
      // The inline sequence that used to live here — existence guards, merge and
      // stamp, envelope strip, schema, validate, unique — is now
      // `runWritePipeline`, which *decides* and returns a typed outcome. This
      // handler still *commits*, and that split is deliberate: everything below
      // the commit (afterWrite, the response) is a side effect of committing and
      // belongs to the caller, not to a pure pipeline.
      //
      // Two things that MUST stay wired, both of which a naive "replace the whole
      // block" cutover drops:
      //   1. `afterWrite` — it is post-commit cache invalidation and it is NOT in
      //      the pipeline (by design). Dropping it makes the blog serve stale
      //      content for up to 24h, the exact bug it was added to fix.
      //   2. `isUnique`'s document identity — see the binding note in
      //      write-pipeline.ts. Self-exclusion is bound HERE; a fresh 2-arg
      //      implementation that ignores `ref` would fail every update.

      // A storage area's documents describe files and are written ONLY by
      // /blob, which stores the bytes first (#1136). A direct write here could
      // make a metadata document with no file behind it.
      if (config.blob) {
        fail(res, 403, 'refused', 'files in a storage area are written through /blob')
        break
      }

      // An IMMUTABLE or SEQUENCED collection commits through the transactional
      // path /docs uses (#1184): existence, the pipeline, uniqueness and the
      // sequence counter are all read INSIDE one transaction. On the path below
      // they are read outside the commit, so two concurrent creates of one new
      // id both saw "missing" and both committed — the second re-sequencing the
      // first, which for a log is corruption.
      if (config.immutable || config.seq) {
        let outcome: CommitOutcome
        try {
          outcome = await commitTransactionally(
            [
              {
                p: canonicalPath,
                method: req.method as WriteMethod,
                data: req.body.data as Record<string, unknown>,
              },
            ],
            { [_collectionPath]: config },
            userRoles
          )
        } catch (e) {
          log.error(`Error saving ${path}:`, e)
          fail(res, 500, 'internal', 'save failed')
          break
        }
        if (outcome.status === 'refused') {
          const { refusal } = outcome
          fail(
            res,
            rejectionStatus(refusal.reason as RejectionReason),
            refusal.reason as never,
            refusal.message,
            refusal.details ? { details: refusal.details } : {}
          )
          break
        }
        res
          .status(200)
          .send(
            outcome.out.length === 0
              ? `unchanged ${path}`
              : `${req.method === 'POST' ? 'created' : 'updated'} ${path}`
          )
        break
      }

      const existing = doc.data
      // Single clock reading for the whole request (§4.1: no ambient time).
      const now = new Date().toJSON()

      const outcome = await runWritePipeline(
        {
          method: req.method as WriteMethod,
          body: req.body.data as Record<string, unknown>,
          existing,
          // Explicit, not inferred: Firestore allows an empty document, for
          // which `doc.exists` is true but `existing` has no keys.
          exists: doc.exists,
          config,
          userRoles,
        },
        {
          now: () => now,
          isUnique: (field, value) =>
            store.isUnique(_collectionPath, field, value, canonicalPath),
        }
      )

      if (outcome.status === 'rejected') {
        // One status map for /doc and /docs (errors.ts rejectionStatus). These
        // refusals come AFTER the access gate, so none is the opaque 404: the
        // caller already holds write access, and telling them a document exists
        // (or conflicts) is not a disclosure (review F5). The pipeline's reason
        // is the stable error code (#20); `schema` carries its details.
        fail(
          res,
          rejectionStatus(outcome.reason),
          outcome.reason,
          outcome.message,
          outcome.details ? { details: outcome.details } : {}
        )
        return
      }

      if (outcome.status === 'noop') {
        // §3: an unchanged body neither writes nor re-stamps. The inline path
        // re-stamped `_modified` on every PUT, so identical re-saves churned
        // provenance and invalidated caches for nothing. No commit means no
        // `afterWrite` — there is nothing to invalidate.
        res.status(200).send(`unchanged ${path}`)
        return
      }

      const data = outcome.data
      try {
        // (Sequenced and immutable collections never reach here: they commit
        // transactionally above.)
        await store.set(canonicalPath, data)
        // Post-commit side effects (cache invalidation, etc). Deliberately
        // after the write — see CollectionConfig.afterWrite. Failures are
        // logged, never surfaced: the write already succeeded, and turning a
        // saved document into an error response would be a worse lie than a
        // stale cache.
        if (config.afterWrite) {
          try {
            await config.afterWrite(data, userRoles, {
              path: canonicalPath,
              before: doc.exists ? (existing as Record<string, unknown>) : undefined,
              after: data,
            })
          } catch (e) {
            log.warn(`afterWrite failed for ${path}:`, e)
          }
        }
        res
          .status(200)
          .send(`${req.method === 'POST' ? 'created' : 'updated'} ${path}`)
      } catch (e) {
        log.error(`Error saving ${path}:`, e)
        fail(res, 500, 'internal', 'save failed')
      }
      break
    }
    default:
      fail(res, 400, 'bad-request', 'bad request type')
  }
}
