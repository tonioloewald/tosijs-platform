import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import * as crypto from 'crypto'
import { Request } from 'firebase-functions/v2/https'
import { Response } from 'express'
import { DecodedIdToken } from 'firebase-admin/auth'

import { UserRoles, anonymousUser } from './collections/roles'

admin.initializeApp()

// Re-export types for use in other modules
export type { Request, Response }

// Extended request with optional user property set after auth
export interface AuthenticatedRequest extends Request {
  user?: DecodedIdToken
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
    functions.logger.error(`[${topic}] ${message}`, e)
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
    res.status(429).send('Too Many Requests')
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
    res.status(403).send('')
    return true
  }
  return false
}

async function getUser(
  req: AuthenticatedRequest
): Promise<DecodedIdToken | false> {
  const authorization = req.headers.authorization
  if (authorization == null) {
    return false
  }
  const idToken = authorization.split('Bearer ')[1]
  if (idToken == null) {
    return false
  }
  try {
    const decodedIdToken = await admin.auth().verifyIdToken(idToken)
    req.user = decodedIdToken
    return decodedIdToken
  } catch (error) {
    functions.logger.error('Error while verifying Firebase ID token:', error)
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
    const userRecord = await admin.auth().getUser(uid)
    const currentClaims = userRecord.customClaims || {}
    const currentRoles = currentClaims.roles || []

    // Only update if roles have changed
    if (JSON.stringify(currentRoles.sort()) !== JSON.stringify(roles.sort())) {
      await admin.auth().setCustomUserClaims(uid, {
        ...currentClaims,
        roles,
      })
    }
  } catch (e) {
    // Custom claims are a nice-to-have for storage rules; log but don't fail
    functions.logger.warn(
      `Failed to sync roles to custom claims for ${uid}:`,
      e
    )
  }
}

async function getUserRoles(req: AuthenticatedRequest): Promise<UserRoles> {
  const user = await getUser(req)
  if (!user) {
    return anonymousUser
  }

  // First, try to find role by userIds (fast path)
  let roles = await getRecords<RoleDoc>(
    'role',
    'userIds',
    'array-contains',
    user.uid,
    2
  )

  if (roles.length === 0 && user.email) {
    // Fallback: find role by email in contacts
    // We need to get all roles and check contacts manually since Firestore
    // doesn't support querying nested array fields directly
    const allRoles = await getRecords<RoleDoc>(
      'role',
      undefined,
      undefined,
      undefined,
      100
    )
    const matchingRole = allRoles.find((role) =>
      role.contacts?.some(
        (contact) =>
          contact.type === 'email' &&
          contact.value?.toLowerCase() === user.email?.toLowerCase()
      )
    )

    if (matchingRole) {
      // Add user's uid to the role's userIds for future fast lookups
      const userIds = matchingRole.userIds || []
      if (!userIds.includes(user.uid)) {
        userIds.push(user.uid)
        if (matchingRole._id) {
          await admin
            .firestore()
            .collection('role')
            .doc(matchingRole._id)
            .update({ userIds })
          functions.logger.info(
            `Added uid ${user.uid} to role ${matchingRole._id} for email ${user.email}`
          )
        }
      }
      roles = [matchingRole]
    }
  }

  // Get the user's role document (if found)
  const firstRole = roles[0]
  const userRole: UserRoles = firstRole
    ? {
        _id: firstRole._id,
        name: firstRole.name || 'unknown',
        contacts: (firstRole.contacts || []).map((c) => ({
          type: c.type as 'email' | 'phone' | 'address',
          value: c.value,
        })),
        roles: (firstRole.roles || []) as UserRoles['roles'],
        userIds: firstRole.userIds || [],
      }
    : anonymousUser

  // Sync roles to custom claims for Storage rules enforcement
  if (userRole !== anonymousUser && userRole.roles?.length > 0) {
    await syncRolesToCustomClaims(user.uid, userRole.roles)
  }

  return userRole
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
  const ref = await admin
    .firestore()
    .collection(collection)
    .doc(id)
    .collection('versions')
    .doc(version)
    .get()

  return ref.exists ? (ref.data() as T) : undefined
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
  const ref = await admin
    .firestore()
    .collection(collectionName)
    .doc(String(id))
    .get()
  if (!ref.exists) {
    return undefined
  }
  const data = ref.data() as T | undefined
  return data === undefined || data._deleted === true
    ? undefined
    : { ...data, _id: id, _collection: collectionName }
}

type WhereFilterOp = FirebaseFirestore.WhereFilterOp
type OrderByDirection = FirebaseFirestore.OrderByDirection

async function getRecords<T extends FirestoreDoc = FirestoreDoc>(
  collectionName: string,
  field?: string,
  operator?: WhereFilterOp,
  value?: unknown,
  maxRecords = 10000,
  since?: string,
  orderBy = '_created desc'
): Promise<T[]> {
  let ref: FirebaseFirestore.Query = admin
    .firestore()
    .collection(collectionName)
    .limit(maxRecords)
  if (value !== undefined && field && operator) {
    ref = ref.where(field, operator, value)
  }
  if (since !== undefined) {
    ref = ref.orderBy('_modified', 'desc')
    ref = ref.where('_modified', '>', since)
  } else {
    const [orderField, direction] = orderBy.split(' ')
    if (orderField !== '~') {
      ref = ref.orderBy(orderField, (direction as OrderByDirection) || 'asc')
    }
  }
  const snapshot = await ref.get()
  const records: T[] = []
  if (!snapshot.empty) {
    snapshot.forEach((doc) => {
      const data = doc.data() as T
      if (data._deleted !== true) {
        records.push({
          ...data,
          _id: doc.id,
          _collection: collectionName,
        })
      }
    })
  }
  return records
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
      await admin
        .firestore()
        .collection(collectionName)
        .doc(id)
        .collection('versions')
        .doc()
        .set(versionRecord)
    }
    if (publish) {
      await admin.firestore().collection(collectionName).doc(id).set(record)
    }
  } else {
    const docRef = admin.firestore().collection(collectionName).doc()
    delete record._collection
    record._id = id = docRef.id
    await docRef.set(record)
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
