import { initializeApp } from 'firebase/app'
import {
  getAuth,
  signOut,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  connectAuthEmulator,
  User,
  GoogleAuthProvider,
  signInWithPopup,
} from 'firebase/auth'
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  getCountFromServer,
  getDocs,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  Unsubscribe,
  limit,
  orderBy,
  Query,
  QueryConstraint,
  QueryCompositeFilterConstraint,
  startAfter,
} from 'firebase/firestore'
import { getStorage, connectStorageEmulator } from 'firebase/storage'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'
import {
  EventNameString,
  getAnalytics,
  logEvent as _logEvent,
} from 'firebase/analytics'
import { config, PRODUCTION_BASE } from './firebase-config'
import { randomID } from './random-id'
import { postNotification, makeSorter } from 'tosijs-ui'

const defaultSort = makeSorter((r: any) => [r._created], false)

export const DEFAULT_LIMIT = 2500
let timerId = 0

const timestamp = () => new Date().toISOString()

export let perf = false

export const setPerf = (_perf: boolean) => {
  perf = _perf
}

let firebaseUser: any | undefined

export const getFirebaseUser = () => firebaseUser

type Ref = {
  path: string
}

type Geopoint = {
  _lat: number
  _long: number
}

interface Timestamp {
  seconds: number
  nanoseconds: number
}

interface FirestoreRef {
  firestore: object
}

// deals with some of firestore unique data types that explode when cloned
export function simplify(record: any): any {
  const clone: any = {}
  for (const key of Object.keys(record)) {
    const value = record[key]
    if (typeof value !== 'object' || value === null) {
      clone[key] = value
    } else {
      if (
        (value as unknown as FirestoreRef).firestore !== null &&
        typeof (value as unknown as FirestoreRef).firestore === 'object'
      ) {
        const { path } = value as Ref
        clone[key] = { _firestore_type: 'ref', path }
      } else if (
        typeof (value as Geopoint)._lat === 'number' &&
        typeof (value as Geopoint)._long === 'number'
      ) {
        const { _lat, _long } = value as Geopoint
        clone[key] = { _firestore_type: 'geopoint', _lat, _long }
      } else if (
        typeof (value as unknown as Timestamp).seconds === 'number' &&
        typeof (value as unknown as Timestamp).nanoseconds === 'number'
      ) {
        const { seconds, nanoseconds } = value as unknown as Timestamp
        clone[key] = new Date(seconds * 1000 + nanoseconds * 1e-6).toISOString()
      } else if (Array.isArray(value)) {
        clone[key] = value.map((x) =>
          x === null || typeof x !== 'object' ? x : simplify(x)
        ) as any
      } else {
        clone[key] = simplify(value)
      }
    }
  }
  return clone
}

export type Metadata = {
  id: string
  collection: string
}
export const getMetadata = (obj: any): Metadata =>
  obj._id != null && obj._collection != null
    ? { id: obj._id, collection: obj._collection }
    : { id: '', collection: '' }

export const setMetadata = (obj: any, data: Metadata) => {
  obj._id = data.id
  obj._collection = data.collection
}

const removeMetadata = (obj: any) => {
  delete obj._id
  delete obj._collection
}

const TEST_MODE =
  globalThis.location.protocol === 'http:' &&
  globalThis.localStorage.getItem('use-prod') === null

if (TEST_MODE) {
  console.warn('using local emulated services')
}

// `bun run serve:local`'s dev sign-in (/__dev/login, LOCAL hosts only): an
// unsigned identity token kept in localStorage, sent in place of a Firebase ID
// token. Read in TEST_MODE only; a production host would refuse it anyway.
const DEV_IDENTITY_KEY = 'dev-identity-token'
const DEV_LOGIN_PATH = '/__dev/login'
const devIdentityToken = TEST_MODE
  ? globalThis.localStorage.getItem(DEV_IDENTITY_KEY)
  : null
const devUser = (token: string) => {
  let claims: Record<string, any> = {}
  try {
    const b64 = token.slice('dev.'.length).replace(/-/g, '+').replace(/_/g, '/')
    claims = JSON.parse(atob(b64))
  } catch {
    // a malformed token: the server will treat the caller as anonymous
  }
  return {
    uid: claims.sub,
    email: claims.email ?? null,
    displayName: claims.name || claims.email || claims.sub,
    isDevIdentity: true,
    getIdToken: async () => token,
  }
}

export const isProd = (): boolean => !TEST_MODE

export const getEnvironment = (): string => (TEST_MODE ? 'stage' : 'production')

console.log('initializing app')
export const firebaseApp = initializeApp(config)

/* auth */
export const auth = getAuth(firebaseApp)

/* analytics */
export const analytics = getAnalytics(firebaseApp)

interface AnalyticsEventParams {
  [key: string]: any
}

export const logEvent = (
  eventName: EventNameString,
  params?: AnalyticsEventParams
) => {
  if (location.hostname === 'localhost') {
    console.log('logEvent', { eventName, params })
  } else {
    // @ts-expect-error wtf?
    _logEvent(analytics, eventName, params)
  }
}

if (TEST_MODE) {
  const emulatorHost = globalThis.location.hostname // 'localhost' or '127.0.0.1'
  connectAuthEmulator(auth, `http://${emulatorHost}:9099`)
  connectFirestoreEmulator(getFirestore(), emulatorHost, 8080)
  connectStorageEmulator(getStorage(), emulatorHost, 9199)
  connectFunctionsEmulator(getFunctions(), emulatorHost, 5001)
}

type Listener = (user: any) => void
export const authStateChangeListeners: Set<Listener> = new Set()

auth.languageCode = 'en'
const div = globalThis.document.createElement('div')
div.id = 'firebase-signin'
Object.assign(div.style, {
  position: 'fixed',
  bottom: '0',
  left: '50vh',
  transform: 'translateX(-50%)',
})
globalThis.document.body.append(div)

setPersistence(auth, browserLocalPersistence).catch(() => {
  console.error('failed to set persistence')
})
onAuthStateChanged(auth, async (user) => {
  // A dev identity, when there is one, stands in for whoever Firebase has.
  firebaseUser = devIdentityToken ? devUser(devIdentityToken) : user
  authStateChangeListeners.forEach((f) => f(firebaseUser))
})

export function userAvailable(): Promise<User | null> {
  return new Promise((resolve) => {
    const callback = (user: User | null) => {
      resolve(user)
      authStateChangeListeners.delete(callback)
    }
    authStateChangeListeners.add(callback)
  })
}

export function userSignout(): void {
  if (devIdentityToken) {
    globalThis.location.href = `${DEV_LOGIN_PATH}?signout`
    return
  }
  signOut(auth).catch((error) => {
    console.error('signout failed', error)
    postNotification({ type: 'error', message: 'Signout failed?!' })
  })
}

/* firestore */

const firestore = getFirestore(firebaseApp)

export type FirestoreOperator =
  | '<'
  | '<='
  | '>='
  | '>'
  | '=='
  | '!='
  | 'array-contains'
  | 'array-contains-any'
  | 'in'
  | 'not-in'
export type WhereQuerySpec = {
  field: string
  operator: FirestoreOperator
  value: any
}
export type FirestoreQuery =
  | WhereQuerySpec
  | QueryConstraint
  | QueryCompositeFilterConstraint

function buildQuery(
  collectionName: string,
  condition?: FirestoreQuery,
  maxRecords = DEFAULT_LIMIT,
  sortField = ''
): Query {
  let q, ordering
  if (sortField !== '') {
    const [field, order] = sortField.split(' ')
    ordering = order === 'desc' ? orderBy(field, 'desc') : orderBy(field)
    console.log(collectionName, field, order)
  }
  if (condition == null) {
    q = ordering
      ? query(
          collection(firestore, collectionName),
          ordering,
          limit(maxRecords)
        )
      : query(collection(firestore, collectionName), limit(maxRecords))
  } else if (
    condition instanceof QueryConstraint ||
    condition instanceof QueryCompositeFilterConstraint
  ) {
    q = ordering
      ? query(
          collection(firestore, collectionName),
          condition as QueryConstraint,
          ordering,
          limit(maxRecords)
        )
      : query(
          collection(firestore, collectionName),
          condition as QueryConstraint,
          limit(maxRecords)
        )
  } else {
    const { field, operator, value } = condition as WhereQuerySpec
    q = ordering
      ? query(
          collection(firestore, collectionName),
          where(field, operator, value),
          ordering,
          limit(maxRecords)
        )
      : query(
          collection(firestore, collectionName),
          where(field, operator, value),
          limit(maxRecords)
        )
  }
  return q
}

const CACHE_VERSION = 1.3
interface CachedQueryResponse {
  created: Date
  records: { [key: string]: any }
  requestSize: number
  version: number
}

export async function getRecords(
  collectionName: string,
  condition?: FirestoreQuery,
  maxRecords = DEFAULT_LIMIT,
  sortField = ''
): Promise<any[]> {
  let records: { [key: string]: any } = {}
  let includeDeleted = false

  if (collectionName.startsWith('~')) {
    collectionName = collectionName.substring(1)
    includeDeleted = true
  }

  if (condition === undefined && sortField === '') {
    sortField = '_created desc'
  }

  let count = 0
  const querySnapshot = await getDocs(
    buildQuery(collectionName, condition, maxRecords, sortField)
  )
  querySnapshot.forEach((doc): void => {
    const data = doc.data()
    count += 1
    if (includeDeleted || data._deleted !== true) {
      setMetadata(data, {
        id: doc.id,
        collection: collectionName,
      })
      records[doc.id] = data
    }
  })

  return Object.values(records).sort(defaultSort).slice(-maxRecords)
}

export async function count(collectionName: string): Promise<number> {
  const collectionRef = await collection(firestore, collectionName)
  const snapshot = await getCountFromServer(collectionRef)
  return snapshot.data().count
}

async function _forAllRecords(
  collectionName: string,
  callback: (rec: any) => void | Promise<void>,
  pageSize = 10
): Promise<number> {
  let total = 0
  const collectionRef = collection(firestore, collectionName)
  console.log(
    collectionName,
    'collection has',
    await count(collectionName),
    'records'
  )
  console.log(callback)
  let cursor: any
  const records: any[] = []
  do {
    console.log(`loading another ${pageSize} records, ${total} done so far`)
    const snapshot =
      cursor !== undefined
        ? await getDocs(
            query(
              collectionRef,
              orderBy('_created', 'desc'),
              startAfter(cursor),
              limit(pageSize)
            )
          )
        : await getDocs(
            query(collectionRef, orderBy('_created', 'desc'), limit(pageSize))
          )

    records.splice(0)
    snapshot.forEach((doc): void => {
      cursor = doc
      const data = doc.data()
      if (!data._deleted) {
        setMetadata(data, {
          id: doc.id,
          collection: collectionName,
        })
        records.push(data)
      }
    })
    for (const rec of records) {
      await callback(rec)
      total += 1
    }
  } while (records.length)
  return total
}

export function forAllRecords(
  collection: string,
  callback: (rec: any) => void | Promise<void>,
  pageSize = 10
) {
  _forAllRecords(collection, callback, pageSize).then((count) => {
    console.log(count, 'records processed')
  })
}

export type ChangeType = 'added' | 'modified' | 'removed'
export type ChangeHandler = (type: ChangeType, data: any) => void

export function listenRecords(
  collectionName: string,
  callback: ChangeHandler,
  condition?: FirestoreQuery,
  maxRecords = DEFAULT_LIMIT
): Unsubscribe {
  const unsubscribe = onSnapshot(
    buildQuery(collectionName, condition, maxRecords, '_created desc'),
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const data = simplify(change.doc.data())
        setMetadata(data, { id: change.doc.id, collection: collectionName })
        callback(change.type, data)
      })
    }
  )

  return unsubscribe
}

export const syncRecords = async (
  target: any[],
  collection: string,
  condition?: FirestoreQuery,
  props?: string[],
  sorter = defaultSort,
  maxRecords = DEFAULT_LIMIT
) => {
  if (props !== undefined) {
    const existing = await service.list.post({
      collection,
      props,
      limit: maxRecords,
    })
    target.splice(0)
    target.splice(0, 0, ...existing.records)
    if (condition === undefined) {
      condition = where('_created', '>', existing._created)
    }
  }
  const unsubscribe = listenRecords(
    collection,
    (type, record: any) => {
      const index = target.findIndex((existing) => existing._id === record._id)
      switch (type) {
        case 'added':
        case 'modified':
          if (index > -1) {
            {
              const existing = target[index]
              if (
                existing._modified === undefined ||
                record._modified > existing._modified
              ) {
                target[index] = record
              }
            }
          } else {
            target.unshift(record)
          }
          break
        case 'removed':
          if (index > -1) {
            target.splice(index, 1)
          }
          break
      }
      target.sort(sorter)
    },
    condition,
    maxRecords
  )
  return () => {
    target = [] as any[]
    unsubscribe()
  }
}

export async function getRecord(
  collectionName: string,
  id: string | number,
  includeDeleted = false
): Promise<any | undefined> {
  if (collectionName.startsWith('~')) {
    collectionName = collectionName.substring(1)
    includeDeleted = true
  }

  id = String(id)
  const description = `getRecord('${collectionName}', '${id}') ${++timerId}`
  if (perf) console.time(description)
  const docRef = doc(firestore, collectionName, id)
  const docSnap = await getDoc(docRef)
  if (docSnap.exists()) {
    const data = simplify(docSnap.data())
    if (!includeDeleted && data._deleted === true) {
      console.warn(`${collectionName} ${id} has been deleted`, {
        [`${collectionName}/${id}`]: data,
      })
      if (perf) console.timeEnd(description)
      return undefined
    }
    setMetadata(data, {
      id: docSnap.id,
      collection: collectionName,
    })
    if (perf) console.timeEnd(description)
    return data
  } else {
    console.warn(`${collectionName} ${id} does not exist`)
    if (perf) console.timeEnd(description)
    return undefined
  }
}

export async function updateRecord(data: any) {
  const { id, collection } = getMetadata(data)
  // this will throw an error if the data cannot be serialized
  data = JSON.parse(JSON.stringify(data))
  // and we can strip metadata from the clone safely
  removeMetadata(data)
  return setRecord(collection, data, id)
}

export async function setRecord(
  collectionName: string,
  data: any,
  id?: string,
  versioned: boolean = false
): Promise<string> {
  // TODO use /collection endpoint to get metadata about collection
  // TODO use service.record.put for all setRecord operations
  if (['review', 'test'].includes(collectionName)) {
    return service.record.put({
      p: id ? `${collectionName}/${id}` : collectionName,
      data,
    })
  }

  let existing: any
  try {
    existing =
      id || data._id ? await getRecord(collectionName, id || data._id) : {}
  } catch (e) {
    existing = {}
  }
  if (id == null) {
    id = typeof data._id === 'string' ? (data._id as string) : randomID(16)
  }

  if (versioned && existing._id) {
    const versionNote = prompt('Version Note?', '')
    if (versionNote) {
      data._version_note_ = versionNote
    } else {
      return ''
    }
  }

  const docRef = doc(firestore, collectionName, id)
  const record = { ...data, _created: existing?._created || timestamp() }

  record._modified = timestamp()
  await setDoc(docRef, record)
  if (versioned && existing) {
    const version = { ...existing }
    delete version._created
    const id = String(
      version._modified
        ? new Date(version._modified).valueOf()
        : String(Date.now)
    )
    delete version._modified
    delete version._id
    delete version._collection
    const versionRef = doc(docRef, 'versions', id)
    await setDoc(versionRef, version)
  }
  return id
}

interface Version {
  timestamp: string
  note?: string
  data: any
}

export async function getVersions(
  collectionName: string,
  id: string,
  max = 20
): Promise<Version[]> {
  const docRef = doc(firestore, collectionName, id)
  const docSnap = await getDoc(docRef)
  if (!docSnap.exists()) {
    return []
  }
  const querySnapshot = await getDocs(
    query(collection(docRef, 'versions'), limit(max))
  )
  const records: Version[] = []
  querySnapshot.forEach((doc): void => {
    const data = doc.data()
    const note = data._version_note_
    records.push({
      timestamp: doc.id,
      note,
      data,
    })
  })

  return records
}

export async function deleteRecord(data: any): Promise<boolean> {
  const { id, collection } = getMetadata(data)
  const existing = await getRecord(`~${collection}`, id)
  if (existing == null) {
    console.warn(`cannot delete ${collection}/${id}, it doesn't exist`)
    return false
  } else {
    const docRef = doc(firestore, data._collection, id)
    data._origCollection = collection
    data._origId = id
    delete data._id
    delete data._collection
    await setRecord('deleted', data)
    await deleteDoc(docRef)
    return true
  }
}

// REST services

export const baseServiceUrl = TEST_MODE
  ? `http://${globalThis.location.hostname}:5001/${config.projectId}/us-central1/`
  : PRODUCTION_BASE

export async function json({
  endpoint = '',
  method = 'GET',
  payload = null,
  mode = 'cors',
  cache = 'no-cache',
  credentials = 'same-origin',
  redirect = 'follow',
  referrerPolicy = 'no-referrer',
}): Promise<any> {
  if (endpoint === '') {
    throw new Error('json request failed, endpoint required!')
  }
  const url = `${baseServiceUrl}${endpoint}`
  // Default options are marked with *
  const config = {
    method,
    mode, // no-cors, *cors, same-origin
    cache, // *default, no-cache, reload, force-cache, only-if-cached
    credentials, // include, *same-origin, omit
    headers: {
      'Content-Type': 'application/json',
    },
    redirect,
    referrerPolicy, // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
    ...(payload != null ? { body: JSON.stringify(payload) } : {}),
  } as RequestInit
  const response = await window.fetch(url, config)
  return await response.json() // parses JSON response into native JavaScript objects
}

const FETCH_DEFAULTS = {
  method: 'GET',
  mode: 'cors',
  cache: 'no-cache',
  credentials: 'same-origin',
  headers: {
    'Content-Type': 'application/json',
  },
  redirect: 'follow',
  refererPolicy: 'no-referrer',
}

const deepClone = (obj: any): any => {
  return JSON.parse(JSON.stringify(obj))
}

export type ServiceRequest<T = any> = (
  data?: any,
  options?: RequestInit
) => Promise<T>
export interface ServiceEndpoint {
  head: ServiceRequest
  options: ServiceRequest
  get: ServiceRequest
  post: ServiceRequest
  patch: ServiceRequest
  put: ServiceRequest
  delete: ServiceRequest
}

export type ServiceRequestType = keyof ServiceEndpoint

interface ServiceProxy {
  [key: string | symbol]: ServiceEndpoint
}

export const service = new Proxy(
  {},
  {
    get(_target, url: string): ServiceEndpoint {
      return new Proxy({} as ServiceEndpoint, {
        get(_target, method: string) {
          method = method.toLocaleUpperCase()
          if (method.match(/HEAD|OPTIONS|GET|POST|PUT|PATCH|DELETE/)) {
            return async (data?: any, options?: RequestInit) => {
              const description = `${method} ${url} ${++timerId}`
              if (perf) console.time(description)

              // Build the request fresh on each attempt: this keeps a retry from
              // inheriting a mutated URL/body, and lets us re-mint the auth token
              // on the second try. `forceRefreshToken` forces Firebase to fetch a
              // new ID token instead of returning its cached one.
              const sendRequest = async (
                forceRefreshToken: boolean
              ): Promise<Response> => {
                const requestOptions = Object.assign(
                  deepClone(FETCH_DEFAULTS),
                  options
                ) as RequestInit
                if (firebaseUser) {
                  // @ts-expect-error headers is always a plain object here
                  requestOptions.headers['Authorization'] =
                    'Bearer ' +
                    (await firebaseUser.getIdToken(forceRefreshToken))
                }
                let requestUrl = `${baseServiceUrl}${String(url)}`
                if (data != null) {
                  if (method.match(/GET|DELETE/)) {
                    requestUrl += '?' + new URLSearchParams(data).toString()
                  } else if (method.match(/POST|PUT|PATCH/)) {
                    requestOptions.body = JSON.stringify(data)
                  } else {
                    throw new Error(`${method} request may not have body!`)
                  }
                }
                requestOptions.method = method
                return fetch(requestUrl, requestOptions)
              }

              let response = await sendRequest(false)

              // Stale-token recovery. When an ID token has expired the server
              // can't verify it and falls back to treating the caller as
              // anonymous (see functions/src/utilities.ts getUser), so an
              // authorized write returns 401/403/404 rather than a token error.
              // Force-refresh the token and retry once before surfacing the
              // failure — this is what a manual page refresh did by hand.
              // Restricted to mutating methods so read probes (which legitimately
              // 404) don't pay a double round-trip, and these denial statuses are
              // deterministic given doc state, so retrying can't double-write.
              if (
                firebaseUser &&
                method.match(/POST|PUT|PATCH|DELETE/) &&
                [401, 403, 404].includes(response.status)
              ) {
                console.warn(
                  `${method} ${url} returned ${response.status}; refreshing auth token and retrying once`
                )
                response = await sendRequest(true)
              }

              if (Math.floor(response.status / 100) !== 2) {
                const message = await response.text()
                console.error(
                  `%c${method} ${url} %cfailed with status %c${response.status}: %c${message}`,
                  'color: blue',
                  'color: default',
                  'color: red',
                  'color: white; background: #444; padding: 0 5px;'
                )
                console.log({
                  data,
                })
                return new Error(message)
              }
              const payload =
                response.headers.get('Content-Type') ===
                'application/json; charset=utf-8'
                  ? await response.json()
                  : undefined
              if (perf) console.timeEnd(description)
              return payload
            }
          } else {
            throw new Error(`expect REST method, received ${String(method)}`)
          }
        },
      })
    },
  }
) as ServiceProxy

export function signinWithGoogle(
  successCallback = () => {
    postNotification({
      type: 'success',
      message: 'You are signed in',
      duration: 2,
    })
  },
  failureCallback = () => {
    postNotification({ type: 'error', message: 'Sign in failed' })
  }
): void {
  // On a local host (serve:local), sign in through its dev sign-in page.
  if (TEST_MODE) {
    fetch(DEV_LOGIN_PATH, { method: 'HEAD' })
      .then((res) => {
        // The header, not the status: a catch-all page server answers 200 too.
        if (res.headers.get('x-dev-login'))
          globalThis.location.href = DEV_LOGIN_PATH
        else signinWithGoogleNow(successCallback, failureCallback)
      })
      .catch(() => signinWithGoogleNow(successCallback, failureCallback))
    return
  }
  signinWithGoogleNow(successCallback, failureCallback)
}

function signinWithGoogleNow(
  successCallback: () => void,
  failureCallback: () => void
): void {
  logEvent('login', {
    method: 'google',
  })
  const provider = new GoogleAuthProvider()
  signInWithPopup(auth, provider).then(successCallback).catch(failureCallback)
}
