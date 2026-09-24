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

import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import compression from 'compression'

import * as functions from 'firebase-functions'
import {
  optionsResponse,
  getUserRoles,
  AuthenticatedRequest,
} from './utilities'
import { Response } from 'express'
import {
  collectionPath,
  getMethodAccess,
  REST_METHOD,
  ALL,
  hasPrivilegedRole,
  opaqueStatus,
  type CollectionMap,
} from './collections/access'
import { COLLECTIONS } from './collections'
import { collectionsFor } from './install/installed'
import { UserRoles } from './collections/roles'
import {
  runWritePipeline,
  type WriteMethod,
} from './collections/write-pipeline'
import { FirestoreStore } from './firestore-store'
import { fail, notFound } from './errors'
import { commitWithSeq } from './collections/sequence'

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

type FirestoreDocRef = FirebaseFirestore.DocumentReference
type FirestoreQuery = FirebaseFirestore.Query
type FirestoreRef = FirestoreDocRef | FirestoreQuery

// Helper type guard for document references
function isDocRef(ref: FirestoreRef): ref is FirestoreDocRef {
  return 'id' in ref && 'set' in ref
}

export const getRef = async (
  path: string,
  isCollection = false,
  // Which configs to resolve `field=value` against. Defaults to the compiled
  // platform map; a namespaced request passes the merged map so an installed
  // collection's own `unique`/`tagFields` are honoured. NOT a global read: see
  // `collectionsFor`, which short-circuits bare names to exactly this default.
  collections: CollectionMap = COLLECTIONS
): Promise<FirestoreRef | Error> => {
  const pathParts = path.split('/')

  // Use any internally for the building phase, then return typed result
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ref: any = admin.firestore()
  const collectionStack: string[] = []
  while (pathParts.length) {
    const collection = pathParts.shift()
    if (collection) collectionStack.push(collection)
    const docSpecifier = pathParts.shift()

    if (!collection) {
      // should never happen because we have an even number of parts
      throw new Error('expected collection')
    }

    if (!docSpecifier) {
      if (!isCollection || pathParts.length) {
        throw new Error('expected docSpecifier')
      }
      ref = ref.collection(collection)
    } else if (!docSpecifier.includes('=')) {
      ref = ref.collection(collection).doc(docSpecifier)
    } else {
      const [field, value] = docSpecifier.split('=', 2)
      const config = collections[collectionStack.join('/')]
      const isUnique = config?.unique?.includes(field)
      const isTagField = config?.tagFields?.includes(field)
      if (!isUnique && !isTagField) {
        return new Error(
          `${path} is not allowed; ${field} is not an allowed key`
        )
      }
      const operator = isTagField ? 'array-contains' : '=='

      // For collection queries, return the query reference instead of resolving to a single doc
      const collRef = ref.collection(collection)
      if (isCollection) {
        ref = collRef.where(
          field,
          operator as FirebaseFirestore.WhereFilterOp,
          value
        )
      } else {
        const snapshot = await collRef
          .where(field, operator as FirebaseFirestore.WhereFilterOp, value)
          .limit(1)
          .get()
        let id: string | null = null
        if (!snapshot.empty) {
          snapshot.forEach((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
            id = doc.id
          })
        }
        if (id === null) {
          return new Error(`record not found ${path}`)
        }

        ref = collRef.doc(id)
      }
    }
  }

  return ref as FirestoreRef
}

const isUnique = async (
  path: string,
  field: string,
  value: unknown,
  existing: FirebaseFirestore.DocumentReference
): Promise<boolean> => {
  if (!['string', 'number'].includes(typeof value)) {
    return false
  }
  const parts = path.split('/')
  parts.pop()
  const ref = await getRef(parts.join('/'), true)
  if (ref instanceof Error) {
    return false
  }
  let duplicate = false
  const snapshot = await (ref as FirebaseFirestore.Query)
    .where(field, '==', value)
    .limit(2)
    .get()
  if (!snapshot.empty) {
    snapshot.forEach((doc) => {
      if (doc.id !== existing.id) {
        duplicate = true
      }
    })
  }

  return !duplicate
}

/**
 * The substrate the endpoint's MUTATIONS go through (tosijs-platform#7).
 *
 * `getRef`/`isUnique` are injected rather than imported by the store, which
 * keeps the dependency acyclic and — more importantly — means the ported code
 * runs the exact same resolution and uniqueness logic it did before. The port
 * changes who the endpoint talks to, not what it says.
 *
 * Built PER REQUEST rather than once at module load, because `getRef` now has
 * to resolve `field=value` against the collection map for that request — and a
 * module-level store would silently resolve an installed collection's unique
 * key against the platform map, which has no entry for it, and reject every
 * such path as "not an allowed key".
 */
const storeFor = (collections: CollectionMap) =>
  new FirestoreStore({
    getRef: (path, isCollection) => getRef(path, isCollection, collections),
    isUnique,
  })

export const getDoc = async (
  req: AuthenticatedRequest,
  res: Response,
  path: string
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
    const cacheSeconds = config?.cacheLatencySeconds
    if (cacheSeconds) {
      const cached = docCache.get(path)
      if (cached && cached.expiry > Date.now()) {
        // Update last access time for LRU
        cached.lastAccess = Date.now()
        return { ok: true, data: cached.data }
      }
    }

    const ref = await getRef(path, false, collections)
    if (ref instanceof Error) {
      return opaqueError(userRoles, ref.message, 404)
    }
    if (!isDocRef(ref)) {
      return opaqueError(userRoles, 'invalid path for document', 400)
    }

    const doc = await ref.get()
    if (!doc.exists) {
      return { ok: false, reason: 'not found', status: 404 }
    }

    let data = doc.data() as Record<string, unknown> | undefined
    if (access === ALL) {
      data = { ...data, _path: path }
    } else if (typeof access === 'function') {
      const filtered = await access(data, userRoles)
      if (filtered instanceof Error) {
        return opaqueError(userRoles, filtered.message, 403)
      }
      data = { ...filtered, _path: path }
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

export const doc = onRequest({}, async (req, res) => {
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
  // GET still uses `getRef` below — `docs.ts` and the read path are the
  // remaining half of #7, and porting them together with the query semantics
  // (filter-before-limit, D7) is a separate change.
  const store = storeFor(collections)
  const canonicalPath = await store.resolve(path)
  if (canonicalPath instanceof Error) {
    notFound(res)
    return
  }

  const ref = await getRef(path, false, collections)
  if (ref instanceof Error) {
    notFound(res)
    return
  }
  if (!isDocRef(ref)) {
    fail(res, 400, 'bad-request', 'invalid path')
    return
  }
  const doc = await store.get(canonicalPath)

  switch (req.method) {
    case 'GET':
      if (doc.exists) {
        let data = doc.data as Record<string, unknown> | undefined
        if (access === ALL) {
          data = { ...data, _path: path }
        } else if (typeof access === 'function') {
          const filtered = await access(data, userRoles)
          data = { ...filtered, _path: path }
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
      if (doc.exists && access === ALL) {
        try {
          const deleted = doc.data as Record<string, unknown>
          await store.delete(canonicalPath)
          // A delete mutates the collection exactly as a write does, so it must
          // invalidate the same caches. Omitting this was the original bug's twin:
          // edits were fixed while deleting a post still served it for up to 24h.
          if (config.afterWrite) {
            try {
              await config.afterWrite(deleted, userRoles)
            } catch (e) {
              functions.logger.warn(`afterWrite failed for ${path}:`, e)
            }
          }
          res.status(200).send('')
        } catch (e) {
          functions.logger.error(`Error deleting ${path}:`, e)
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
        // Existence rejections stay 403 (not 404): this point is reached only
        // AFTER the access gate, so the caller already holds write access and
        // telling them a document exists is not a disclosure. 404-ing them would
        // degrade an author's error messages for no security gain (review F5).
        if (
          outcome.reason === 'exists' ||
          outcome.reason === 'missing' ||
          outcome.reason === 'unattributed'
        ) {
          fail(res, 403, outcome.reason, outcome.message)
        } else if (outcome.reason === 'immutable') {
          // 409: the request is well-formed and authorized, and conflicts with
          // what is stored. Retrying it cannot succeed; sending what is stored
          // would.
          fail(res, 409, 'immutable', outcome.message)
        } else if (outcome.reason === 'schema') {
          fail(res, 400, 'schema', outcome.message, {
            details: outcome.details,
          })
        } else {
          // `validate` and `unique`. Note this now surfaces the validator's own
          // message where the inline path sent a fixed 'validation failed' and
          // discarded it — a deliberate improvement, and the reason a rejected
          // write is finally debuggable.
          fail(res, 400, outcome.reason, outcome.message)
        }
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
        if (config.seq) {
          // Sequenced collections commit through a transaction that also
          // advances the counter (#14). Assigned HERE rather than in the
          // pipeline for two reasons: the pipeline is pure and has no I/O, and
          // it decides `noop` only after validation — so a sequence assigned
          // earlier would be burnt on writes that never happen, leaving gaps a
          // replica cannot distinguish from missed events.
          await commitWithSeq(_collectionPath, canonicalPath, data, ref)
        } else {
          await store.set(canonicalPath, data)
        }
        // Post-commit side effects (cache invalidation, etc). Deliberately
        // after the write — see CollectionConfig.afterWrite. Failures are
        // logged, never surfaced: the write already succeeded, and turning a
        // saved document into an error response would be a worse lie than a
        // stale cache.
        if (config.afterWrite) {
          try {
            await config.afterWrite(data, userRoles)
          } catch (e) {
            functions.logger.warn(`afterWrite failed for ${path}:`, e)
          }
        }
        res
          .status(200)
          .send(`${req.method === 'POST' ? 'created' : 'updated'} ${path}`)
      } catch (e) {
        functions.logger.error(`Error saving ${path}:`, e)
        fail(res, 500, 'internal', 'save failed')
      }
      break
    }
    default:
      fail(res, 400, 'bad-request', 'bad request type')
  }
})
