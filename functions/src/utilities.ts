import { fail, noStore } from './errors'
import { log } from './log'
import * as crypto from 'crypto'
import type { HttpRequest as Request } from './http'
import { Response } from 'express'
import { identity, type VerifiedIdentity } from './identity'

import { UserRoles } from './collections/roles'
import { resolvePrincipal } from './collections/principal'
import { firestoreQuery, firestoreStore } from './adapters/firebase/firestore-store'
import { newDocId, type QueryOptions } from './collections/store'

// Re-export types for use in other modules
export type { Request, Response }

// Extended request with optional user property set after auth
export interface AuthenticatedRequest extends Request {
  user?: VerifiedIdentity
}

// Base interface for Firestore documents with common metadata fields
export interface FirestoreDoc {
  _id?: string
  _collection?: string
  _created?: string
  _modified?: string
  _deleted?: boolean
}

// Role document as stored in Firestore
export interface RoleDoc extends FirestoreDoc {
  name?: string
  roles?: string[]
  userIds?: string[]
  contacts?: Array<{ type: string; value: string }>
}

function getOrigin(req: Request): string {
  // service request vs. front-end server redirect
  const origin = req.headers.origin
  const forwarded = req.headers['x-forwarded-host']
  return (
    (typeof origin === 'string' ? origin : '') ||
    (typeof forwarded === 'string' ? forwarded : '')
  )
}

interface ErrorLogDoc extends FirestoreDoc {
  topic: string
  message: string
}

async function logError(topic: string, message: string): Promise<void> {
  const id =
    topic + '-' + timestamp() + '-' + (Math.random() * 999999).toString(36)

  try {
    await setRecord<ErrorLogDoc>('error-log', { topic, message }, id)
  } catch (e) {
    // Fallback to console if Firestore logging fails
    log.error(`[${topic}] ${message}`, e)
  }
}

// Rate limiting configuration
export interface RateLimitConfig {
  windowMs: number // Time window in milliseconds
  maxRequests: number // Maximum requests per window per IP
}

// Default rate limit: 100 requests per minute per IP
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100,
}

// In-memory rate limit tracking (per function instance)
// Key: IP address, Value: { count, windowStart }
const rateLimitMap = new Map<string, { count: number; windowStart: number }>()

// Clean up old entries periodically (every 5 minutes)
const CLEANUP_INTERVAL = 5 * 60 * 1000
let lastCleanup = Date.now()

function cleanupRateLimitMap(windowMs: number): void {
  const now = Date.now()
  if (now - lastCleanup < CLEANUP_INTERVAL) {
    return
  }
  lastCleanup = now
  const cutoff = now - windowMs * 2 // Keep entries for 2x the window
  for (const [key, value] of rateLimitMap.entries()) {
    if (value.windowStart < cutoff) {
      rateLimitMap.delete(key)
    }
  }
}

function getClientIP(req: Request): string {
  // Firebase Cloud Functions run behind Google's load balancer which sets X-Forwarded-For.
  // The leftmost IP is the original client IP added by Google's infrastructure.
  // This is trustworthy because Google's load balancer overwrites/sanitizes the header.
  // Note: If deployed behind additional proxies, this may need adjustment.
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim()
  }
  return req.ip || 'unknown'
}

function checkRateLimit(
  req: Request,
  res: Response,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT
): boolean {
  const ip = getClientIP(req)
  const now = Date.now()

  // Cleanup old entries occasionally
  cleanupRateLimitMap(config.windowMs)

  const entry = rateLimitMap.get(ip)

  if (!entry || now - entry.windowStart >= config.windowMs) {
    // New window - reset count
    rateLimitMap.set(ip, { count: 1, windowStart: now })
    return false // Not rate limited
  }

  // Within existing window
  entry.count++

  if (entry.count > config.maxRequests) {
    // Rate limited - set headers and return 429
    const retryAfter = Math.ceil(
      (entry.windowStart + config.windowMs - now) / 1000
    )
    res.set('Retry-After', String(retryAfter))
    res.set('X-RateLimit-Limit', String(config.maxRequests))
    res.set('X-RateLimit-Remaining', '0')
    res.set(
      'X-RateLimit-Reset',
      String(Math.ceil((entry.windowStart + config.windowMs) / 1000))
    )
    // The shared error shape (#20): `rate-limited` is in the stable code set,
    // and a client told to switch on `error` got a plain-text body here.
    fail(res, 429, 'rate-limited', 'too many requests — retry after the Retry-After interval')
    return true // Rate limited
  }

  // Not rate limited - set informational headers
  res.set('X-RateLimit-Limit', String(config.maxRequests))
  res.set('X-RateLimit-Remaining', String(config.maxRequests - entry.count))
  res.set(
    'X-RateLimit-Reset',
    String(Math.ceil((entry.windowStart + config.windowMs) / 1000))
  )

  return false // Not rate limited
}

function optionsResponse(
  req: Request,
  res: Response,
  options = ['OPTIONS', 'GET'],
  rateLimit: RateLimitConfig | false = DEFAULT_RATE_LIMIT
): boolean {
  const { method } = req
  res.set('Access-Control-Allow-Origin', '*')

  // Check rate limit first (skip for OPTIONS preflight requests)
  if (rateLimit !== false && method !== 'OPTIONS') {
    if (checkRateLimit(req, res, rateLimit)) {
      return true // Rate limited, response already sent
    }
  }

  if (method === 'OPTIONS') {
    if (!options.includes('OPTIONS')) {
      options.push('OPTIONS')
    }
    res.set('Access-Control-Allow-Methods', options.join(', '))
    res.set('Access-Control-Allow-Credentials', 'true')
    res.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Accept, Origin'
    )
    res.set('Access-Control-Max-Age', '3600')
    res.status(204).send('')
    return true
  } else if (!options.includes(method)) {
    noStore(res)
    res.status(403).send('')
    return true
  }
  return false
}

async function getUser(
  req: AuthenticatedRequest
): Promise<VerifiedIdentity | false> {
  const authorization = req.headers.authorization
  if (authorization == null) {
    return false
  }
  const idToken = authorization.split('Bearer ')[1]
  if (idToken == null) {
    return false
  }
  const decodedIdToken = await verifyFirebaseIdToken(idToken)
  if (decodedIdToken) req.user = decodedIdToken
  return decodedIdToken
}

/**
 * The Firebase identity adapter: a Firebase ID token → its verified claims.
 */
async function verifyFirebaseIdToken(
  idToken: string
): Promise<VerifiedIdentity | false> {
  try {
    // `checkRevoked` costs one extra Auth lookup, and buys the difference
    // between "signed out everywhere" meaning it and meaning it in an hour.
    // Without it a disabled or revoked session keeps full access for the
    // remaining life of an already-issued ID token — up to ~1h, during which
    // the only visible state says the user has no access at all.
    //
    // Unauthenticated requests never reach here (no header, early return), so
    // public and SSR traffic pays nothing.
    return await identity().verifyIdToken(idToken)
  } catch (error) {
    // Fails CLOSED in every case, including a transient Auth outage: an
    // unverifiable token is anonymous, never trusted-by-default. Revocation is
    // logged distinctly because it is an expected event, not a malfunction,
    // and burying it in generic errors makes it unfindable.
    const code = (error as { code?: string })?.code
    if (code === 'auth/id-token-revoked') {
      log.info('Rejected a revoked ID token')
    } else {
      log.error('Error while verifying Firebase ID token:', error)
    }
    return false
  }
}

// Sync user roles to Firebase Auth custom claims for use in Storage rules
async function syncRolesToCustomClaims(
  uid: string,
  roles: string[]
): Promise<void> {
  try {
    // Get current custom claims
    const currentClaims = await identity().customClaims(uid)
    const currentRoles = (currentClaims.roles as string[] | undefined) || []

    // Only update if roles have changed
    if (JSON.stringify(currentRoles.sort()) !== JSON.stringify(roles.sort())) {
      await identity().setCustomClaims(uid, {
        ...currentClaims,
        roles,
      })
    }
  } catch (e) {
    // Custom claims are a nice-to-have for storage rules; log but don't fail
    log.warn(
      `Failed to sync roles to custom claims for ${uid}:`,
      e
    )
  }
}

/**
 * The caller's authority. The decision lives in the portable kernel
 * (`collections/principal.ts`); this binds it to Firebase: ID tokens verified
 * by Firebase Auth, `role`/`token` read from Firestore.
 */
async function getUserRoles(req: AuthenticatedRequest): Promise<UserRoles> {
  return resolvePrincipal(req.headers.authorization, {
    store: { query: firestoreQuery },
    verify: async (idToken) => {
      const decoded = await verifyFirebaseIdToken(idToken)
      if (!decoded) return null
      req.user = decoded
      return decoded
    },
    log: {
      warn: (m) => log.warn(m),
      error: (m) => log.error(m),
    },
    // Sync roles to custom claims for Storage rules enforcement.
    //
    // A second source of truth for authorization, written best-effort during a
    // READ, consumed only by `storage.rules`. It is on the list to DELETE along
    // with those rules (#3) — claims are baked into an issued token, so a role
    // revoked here stays live in storage until it expires. Not removed yet
    // because `asset-manager.ts` still uploads to the legacy `public/` folder
    // through the Storage client SDK (#2486); kept deliberately.
    onResolved: syncRolesToCustomClaims,
  })
}

const DAY_IN_MS = 24 * 3600 * 1000
function timestamp(addDays = 0): string {
  return addDays === 0
    ? new Date().toISOString()
    : new Date(Date.now() + addDays * DAY_IN_MS).toISOString()
}

async function getVersion<T extends FirestoreDoc = FirestoreDoc>(
  collection: string,
  id: string,
  version: string
): Promise<T | undefined> {
  const doc = await firestoreStore.get(`${collection}/${id}/versions/${version}`)
  return doc.exists ? (doc.data as T) : undefined
}

async function getRecord<T extends FirestoreDoc = FirestoreDoc>(
  collectionName: string,
  selector: string
): Promise<T | undefined> {
  let id: string | null = selector
  // TODO only allow for uniqueKey in collection
  if (selector.includes('=')) {
    const [field, value] = selector.split('=')
    const [record] = await getRecords<T>(collectionName, field, '==', value, 1)
    id = record ? record._id ?? null : null
  }
  if (id === null) {
    return undefined
  }
  const doc = await firestoreStore.get(`${collectionName}/${String(id)}`)
  if (!doc.exists) {
    return undefined
  }
  const data = doc.data as T
  return data._deleted === true
    ? undefined
    : { ...data, _id: id, _collection: collectionName }
}

/**
 * Records matching one optional condition, over the store port. The query
 * shape (one where, then the order, then the limit) is the one the composite
 * indexes cover (firestore-store.ts, buildQuery).
 */
async function getRecords<T extends FirestoreDoc = FirestoreDoc>(
  collectionName: string,
  field?: string,
  operator?: '==' | 'array-contains',
  value?: unknown,
  maxRecords = 10000,
  since?: string,
  orderBy = '_created desc'
): Promise<T[]> {
  const options: QueryOptions = { limit: maxRecords, orderBy }
  if (value !== undefined && field && operator) {
    if (operator === '==') options.equals = { field, value }
    else options.arrayContains = { field, value }
  }
  if (since !== undefined) {
    options.orderBy = '_modified desc'
    options.greaterThan = { field: '_modified', value: since }
  }
  const docs = await firestoreStore.query(collectionName, options)
  return docs
    .map((doc) => ({ ...(doc.data as T), _id: doc.path.split('/').pop(), _collection: collectionName }))
    .filter((record) => record._deleted !== true)
}

async function setRecord<T extends FirestoreDoc>(
  collectionName: string,
  record: T,
  id?: string,
  returnRecord = false,
  versionNote?: string,
  publish = true
): Promise<T | string> {
  if (id === undefined) {
    id = record._id
  } else {
    id = String(id)
  }
  if (id === 'undefined') {
    const errorMessage = `tried to save record to ${collectionName} with id === 'undefined'`
    logError('setRecord', errorMessage)
    delete record._id
    id = undefined
  }
  if (id !== undefined && record._id !== undefined && record._id !== id) {
    const errorMessage = `cannot save to ${collectionName} with conflicting record._id == ${record._id} and specified id == ${id}`
    logError('setRecord', errorMessage)
    throw new Error(errorMessage)
  }
  if (record._created === undefined) {
    record._created = timestamp()
  }
  record._modified = timestamp()
  if (id !== undefined) {
    record._id = id
    if (versionNote) {
      const versionRecord = {
        ...record,
        _timestamp: new Date().valueOf(),
        _version_note_: versionNote,
      }
      await firestoreStore.set(`${collectionName}/${id}/versions/${newDocId()}`, versionRecord as unknown as Record<string, unknown>)
    }
    if (publish) {
      await firestoreStore.set(`${collectionName}/${id}`, record as Record<string, unknown>)
    }
  } else {
    delete record._collection
    record._id = id = newDocId()
    await firestoreStore.set(`${collectionName}/${id}`, record as Record<string, unknown>)
  }
  return returnRecord ? record : (id as string)
}

async function createRecord<T extends FirestoreDoc>(
  collectionName: string,
  record: T
): Promise<string> {
  delete record._id
  return (await setRecord(collectionName, record)) as string
}

export interface LinkToken {
  expires: string
  token: string
}

function createLinkToken(days = 3): LinkToken {
  const expires = new Date()
  expires.setDate(expires.getDate() + days)
  return {
    expires: expires.toISOString(),
    token: ('00' + crypto.randomInt(Math.pow(36, 9)).toString(36)).slice(-8),
  }
}

type Comparable = string | number | boolean | Date
type SortGetter<T> = (item: T) => Comparable
const identityGetter = <T extends Comparable>(a: T): T => a

function sortRecords<T>(
  records: T[],
  ascending = true,
  getter: SortGetter<T> = identityGetter as SortGetter<T>
): T[] {
  const sorter = ascending
    ? (a: T, b: T) => (getter(a) > getter(b) ? 1 : -1)
    : (a: T, b: T) => (getter(a) > getter(b) ? -1 : 1)

  return records.sort(sorter)
}

export {
  getOrigin,
  optionsResponse,
  getUser,
  getUserRoles,
  timestamp,
  logError,
  getRecord,
  getVersion,
  getRecords,
  createRecord,
  setRecord,
  createLinkToken,
  sortRecords,
}
