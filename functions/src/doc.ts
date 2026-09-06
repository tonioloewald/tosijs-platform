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
} from './collections/access'
import { COLLECTIONS } from './collections'
import { UserRoles } from './collections/roles'
import {
  shadowEnabled,
  shadowCompareWrite,
} from './collections/shadow-compare'
import { validate as schemaValidate } from 'tosijs-schema'

interface SchemaError {
  path: string
  message: string
}

const validateWithSchema = (
  data: any,
  schema: any
): { valid: boolean; errors: SchemaError[] } => {
  const errors: SchemaError[] = []
  const valid = schemaValidate(data, schema, (path, message) => {
    errors.push({ path, message })
  })
  return { valid, errors }
}

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
  isCollection = false
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
      const config = COLLECTIONS[collectionStack.join('/')]
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

export const getDoc = async (
  req: AuthenticatedRequest,
  res: Response,
  path: string
): Promise<DocResult> => {
  const userRoles = await getUserRoles(req)

  try {
    const _collectionPath = collectionPath(path)
    const config = COLLECTIONS[_collectionPath]
    const access = getMethodAccess(
      COLLECTIONS,
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

    const ref = await getRef(path)
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
    res.status(400).send('missing path')
    return
  }

  const pathParts = path.split('/')

  if (pathParts.length % 2 !== 0) {
    res.status(400).send('bad path')
    return
  }

  const _collectionPath = collectionPath(path)
  const config = COLLECTIONS[_collectionPath]

  if (!config) {
    res.status(404).send('not found')
    return
  }

  const access = getMethodAccess(
    COLLECTIONS,
    _collectionPath,
    req.method as REST_METHOD,
    userRoles
  )

  if (!access) {
    // Opaque denial: non-privileged callers get 404 so a protected resource is
    // indistinguishable from a missing one (matches getDoc/opaqueError). Only
    // admin/developer/owner see the real 403.
    if (hasPrivilegedRole(userRoles)) {
      res.status(403).send('forbidden')
    } else {
      res.status(404).send('not found')
    }
    return
  }

  const ref = await getRef(path)
  if (ref instanceof Error) {
    res.status(404).send(ref.message)
    return
  }
  if (!isDocRef(ref)) {
    res.status(400).send('invalid path')
    return
  }
  const doc = await ref.get()

  switch (req.method) {
    case 'GET':
      if (doc.exists) {
        let data = doc.data() as Record<string, unknown> | undefined
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
        res.status(404).send('')
      }
      return

    case 'DELETE':
      if (doc.exists && access === ALL) {
        try {
          const deleted = doc.data() as Record<string, unknown>
          await ref.delete()
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
          res.status(500).send('Delete failed')
        }
      } else {
        res.status(opaqueStatus(userRoles, 403)).send(`no doc at ${path}`)
      }
      break
    case 'POST':
    case 'PUT':
    case 'PATCH':
      // These two are reached only AFTER the access gate above, so the caller
      // already holds write access to this collection — telling them a document
      // exists is not a disclosure, and 404-ing them would degrade an author's
      // error messages for no security gain (review F5). What is worth removing
      // is the reflected path: there is never a reason to echo caller input back.
      if (doc.exists && req.method === 'POST') {
        res.status(403).send('document already exists')
      } else if (!doc.exists && req.method !== 'POST') {
        res.status(403).send('cannot update non-existent document')
      } else {
        const existing = (doc.exists ? doc.data() : {}) as Record<
          string,
          unknown
        >
        // Keep the caller's body as sent, so shadow mode can re-derive the write
        // from the same inputs this handler started from (it is mutated below).
        const shadowBody = shadowEnabled()
          ? ({ ...req.body.data } as Record<string, unknown>)
          : undefined
        const _modified = new Date().toJSON()
        const _created = (existing._created as string) || _modified
        let data =
          req.method === 'PATCH'
            ? { ...existing, ...req.body.data, _created, _modified }
            : { ...req.body.data, _created, _modified }

        // Envelope fields are managed by the endpoint (id from the ref, collection
        // from the path), not part of the content schema — strip them before
        // validation so a strict schema doesn't reject them, and don't store them
        // back as content. `_path` is the request path, also stripped before save.
        delete (data as Record<string, unknown>)._id
        delete (data as Record<string, unknown>)._collection
        delete (data as Record<string, unknown>)._path

        // Schema validation (runs first if schema is defined)
        if (config.schema) {
          const { valid, errors } = validateWithSchema(data, config.schema)
          if (!valid) {
            res.status(400).json({
              error: 'schema validation failed',
              details: errors,
            })
            return
          }
        }

        // Custom validation (runs after schema validation)
        if (config.validate) {
          data = await config.validate(data, userRoles, existing)
          if (data instanceof Error) {
            res.status(400).send('validation failed')
            return
          }
        }
        for (const uniqueField of config.unique || []) {
          if (!(await isUnique(path, uniqueField, data[uniqueField], ref))) {
            res
              .status(400)
              .send(`"${uniqueField}" is required to exist and be unique`)
            return
          }
        }
        try {
          delete data._path
          await ref.set(data)
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

          // Shadow mode (ROADMAP Phase 1 rung 1): re-derive this write through the
          // extracted pipeline and log any divergence. Runs AFTER the response is
          // sent and commits nothing, so it can neither slow nor alter the request.
          // Off unless SHADOW_WRITE_PIPELINE=1.
          if (shadowBody !== undefined) {
            await shadowCompareWrite({
              path,
              method: req.method as 'POST' | 'PUT' | 'PATCH',
              body: shadowBody,
              existing,
              config,
              userRoles,
              actual: data,
              now: _modified,
            })
          }
        } catch (e) {
          functions.logger.error(`Error saving ${path}:`, e)
          res.status(500).send('Save failed')
        }
      }
      break
    default:
      res.status(400).send('bad request type')
  }
})
