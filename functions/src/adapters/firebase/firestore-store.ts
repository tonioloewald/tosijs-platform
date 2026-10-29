/**
 * The Firestore implementation of the substrate port (tosijs-platform#7).
 *
 * An adapter (SOVEREIGN-PLAN.md Phase 1): `collections/` is the portable
 * decision kernel (it is what `service-compris` publishes) and imports nothing
 * from firebase. The vendor binding belongs here, under `adapters/firebase/`.
 *
 * ## Identical by construction
 *
 * Path resolution and uniqueness are INJECTED rather than reimplemented. Those
 * two carry hard-won behaviour — the `field=value` lookup restricted to
 * `unique`/`tagFields` keys, and the self-exclusion that stops a document
 * colliding with itself on update (review F12) — and re-deriving them against
 * the SDK would be a second chance to get them wrong for no benefit. The port
 * is about who the endpoint TALKS TO, not about rewriting what it says.
 *
 * They used to live in `doc.ts`; with the read path on the store too, nothing
 * outside this file needs them, so they moved here (end of this file) and
 * `firestoreStoreFor(collections)` builds the store with them.
 */
import { firebaseAdmin } from './app'
import { FieldPath } from 'firebase-admin/firestore'

import type { Store, StoredDoc, QueryOptions, Tx } from '../../collections/store'
import { physicalPath } from '../../collections/namespace'
import type { CollectionMap } from '../../collections/access'

type DocRef = FirebaseFirestore.DocumentReference
type AnyRef = DocRef | FirebaseFirestore.Query

export interface FirestorePrimitives {
  getRef: (path: string, isCollection?: boolean) => Promise<AnyRef | Error>
  isUnique: (
    path: string,
    field: string,
    value: unknown,
    existing: DocRef
  ) => Promise<boolean>
}

export class FirestoreStore implements Store {
  constructor(private readonly primitives: FirestorePrimitives) {}

  async resolve(path: string): Promise<string | Error> {
    const parts = path.split('/')
    if (parts.length % 2 !== 0) return new Error(`bad path ${path}`)
    const ref = await this.primitives.getRef(path)
    if (ref instanceof Error) return ref
    if (!('id' in ref) || !('set' in ref)) {
      return new Error(`invalid path for document ${path}`)
    }
    // Canonicalize: getRef has already turned every `field=value` into a
    // concrete document, so its own path IS the canonical one. This used to
    // rebuild the path from the even segments plus the id, which is the LOGICAL
    // collection path: right for `post/xyz`, wrong for a sub-collection
    // document (`post/abc/comment/c1` became `post/comment/c1`, which is not a
    // Firestore path at all). Latent, since no host has sub-collections yet;
    // found porting /docs (2026-10-22). Physical == logical today (namespace.ts).
    return (ref as DocRef).path
  }

  private ref(path: string): DocRef {
    // Logical -> physical. The identity function today (`:` is a legal Firestore
    // collection id), so this changes nothing and stored data is untouched. It
    // is applied HERE so that a substrate whose naming rules differ — Postgres
    // table names cannot contain `:` — is a change in namespace.ts and nowhere
    // else. See tosijs-platform#7.
    const parts = physicalPath(path).split('/')
    let ref: FirebaseFirestore.Firestore | DocRef =
      firebaseAdmin().firestore() as FirebaseFirestore.Firestore
    while (parts.length) {
      const collection = parts.shift() as string
      const id = parts.shift() as string
      ref = (
        ref as FirebaseFirestore.Firestore
      ).collection(collection).doc(id) as DocRef
    }
    return ref as DocRef
  }

  async get(path: string): Promise<StoredDoc> {
    const snapshot = await this.ref(path).get()
    return {
      path,
      // Authoritative, not inferred from emptiness — Firestore permits an empty
      // document, where `exists` is true and `data()` has no keys.
      exists: snapshot.exists,
      data: (snapshot.data() ?? {}) as Record<string, unknown>,
    }
  }

  async set(path: string, data: Record<string, unknown>): Promise<void> {
    await this.ref(path).set(data)
  }

  async delete(path: string): Promise<void> {
    await this.ref(path).delete()
  }

  async isUnique(
    _collection: string,
    field: string,
    value: unknown,
    excludingPath: string
  ): Promise<boolean> {
    // `isUnique` derives the collection from the document path itself and needs
    // the ref only to exclude that document from its own collision check.
    return this.primitives.isUnique(
      excludingPath,
      field,
      value,
      this.ref(excludingPath)
    )
  }

  async query(
    collection: string,
    options: QueryOptions = {}
  ): Promise<StoredDoc[]> {
    return firestoreQuery(collection, options)
  }

  scan(
    collection: string,
    options: Omit<QueryOptions, 'limit'>,
    pageSize: number
  ): AsyncIterable<StoredDoc[]> {
    return firestoreScan(collection, options, pageSize)
  }

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return firestoreTransaction(fn)
  }
}

/**
 * `Store.query` against Firestore, with exactly the query shape `getRecords`
 * (`utilities.ts`) issues: one optional `where`, then `orderBy` (default
 * `_created desc`, `~` for none), then `limit`. Kept identical on purpose — an
 * `array-contains` or `==` combined with an order on another field needs a
 * COMPOSITE INDEX, and the ones production has (`firestore.indexes.json`:
 * role.userIds, role.contacts, token.hash, each with `_created desc`) are
 * exactly this shape. A different shape would 500 on a fresh host, and the
 * emulator would not notice (indexes.test.ts).
 *
 * Used by the principal resolver (`collections/principal.ts`) today; `docs.ts`
 * still queries directly (the remaining half of #7) and moves here next.
 */
function buildQuery(
  collection: string,
  options: QueryOptions
): FirebaseFirestore.Query {
  let ref: FirebaseFirestore.Query = firebaseAdmin().firestore()
    .collection(physicalPath(collection))
  if (options.equals) {
    ref = ref.where(options.equals.field, '==', options.equals.value)
  }
  if (options.arrayContains) {
    ref = ref.where(options.arrayContains.field, 'array-contains', options.arrayContains.value)
  }
  if (options.greaterThan) {
    ref = ref.where(options.greaterThan.field, '>', options.greaterThan.value)
  }
  if (options.lessThan) {
    ref = ref.where(options.lessThan.field, '<', options.lessThan.value)
  }
  if (options.oneOf) {
    ref = ref.where(options.oneOf.field, 'in', options.oneOf.values)
  }
  const [field, direction] = (options.orderBy ?? '_created desc').split(' ')
  if (field !== '~') {
    ref = ref.orderBy(field, direction === 'desc' ? 'desc' : 'asc')
  }
  if (options.fields) ref = ref.select(...options.fields)
  return ref
}

const toStored = (collection: string) => (d: FirebaseFirestore.QueryDocumentSnapshot): StoredDoc => ({
  path: `${collection}/${d.id}`,
  exists: true,
  data: d.data() as Record<string, unknown>,
})

export async function firestoreQuery(
  collection: string,
  options: QueryOptions = {}
): Promise<StoredDoc[]> {
  let ref = buildQuery(collection, options)
  if (options.limit) ref = ref.limit(options.limit)
  const snapshot = await ref.get()
  return snapshot.docs.map(toStored(collection))
}

/** `Store.scan` against Firestore: pages chained by `startAfter` the last document. */
export async function* firestoreScan(
  collection: string,
  options: Omit<QueryOptions, 'limit'>,
  pageSize: number
): AsyncIterable<StoredDoc[]> {
  const base = buildQuery(collection, options)
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined
  for (;;) {
    const page = cursor ? base.startAfter(cursor).limit(pageSize) : base.limit(pageSize)
    const snapshot = await page.get()
    if (snapshot.empty) return
    cursor = snapshot.docs[snapshot.docs.length - 1]
    yield snapshot.docs.map(toStored(collection))
    if (snapshot.size < pageSize) return
  }
}

const docRef = (path: string): DocRef => firebaseAdmin().firestore().doc(physicalPath(path))

/**
 * `Store.transaction` against Firestore: `runTransaction`, which retries the
 * body on contention — hence the port's retry-safe rule.
 */
export function firestoreTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return firebaseAdmin().firestore().runTransaction(async (t) => {
    const tx: Tx = {
      get: async (path) => {
        const snapshot = await t.get(docRef(path))
        return {
          path,
          exists: snapshot.exists,
          data: (snapshot.data() ?? {}) as Record<string, unknown>,
        }
      },
      query: async (collection, options = {}) => {
        let ref = buildQuery(collection, options)
        if (options.limit) ref = ref.limit(options.limit)
        const snapshot = await t.get(ref)
        return snapshot.docs.map(toStored(collection))
      },
      set: (path, data, options) => {
        // `mergeFields`, not `merge: true`: the port replaces each named
        // top-level field WHOLE (as `update` does, and as MemoryStore does);
        // `merge: true` would deep-merge a map field instead. FieldPath, so a
        // key containing `.` names one field, not a nested path.
        if (options?.merge) {
          t.set(docRef(path), data, { mergeFields: Object.keys(data).map((k) => new FieldPath(k)) })
        } else t.set(docRef(path), data)
      },
    }
    return fn(tx)
  })
}

/** `Store.get` against Firestore. A missing document is `exists: false`, never a throw. */
export async function firestoreGet(path: string): Promise<StoredDoc> {
  const snapshot = await docRef(path).get()
  return { path, exists: snapshot.exists, data: (snapshot.data() ?? {}) as Record<string, unknown> }
}

/** `Store.delete` against Firestore. Deleting a missing document is not an error. */
export async function firestoreDelete(path: string): Promise<void> {
  await docRef(path).delete()
}

/** `Store.set` against Firestore: a whole-document write (merge is the transaction's). */
export async function firestoreSet(path: string, data: Record<string, unknown>): Promise<void> {
  await docRef(path).set(data)
}

/** Firestore for kernel code that needs no `field=value` path resolution (that needs the per-request collection map; see `storeFor` in doc.ts). */
export const firestoreStore: Pick<Store, 'get' | 'query' | 'scan' | 'transaction' | 'delete'> & {
  set: (path: string, data: Record<string, unknown>) => Promise<void>
} = {
  get: firestoreGet,
  set: firestoreSet,
  query: firestoreQuery,
  delete: firestoreDelete,
  scan: firestoreScan,
  transaction: firestoreTransaction,
}

// ── path resolution and uniqueness (moved from doc.ts) ──────────────────

type FirestoreRef = AnyRef

const getRef = async (
  path: string,
  isCollection = false,
  // Which configs to resolve `field=value` against. Defaults to the compiled
  // platform map; a namespaced request passes the merged map so an installed
  // collection's own `unique`/`tagFields` are honoured. NOT a global read: see
  // REQUIRED, with no default (0.2.0-beta.5 review): a silent default to the
  // compiled map meant a call site that forgot to pass the request's map
  // resolved `field=value` against rules that, with the registry switch on,
  // are no longer the ones in force. A forgotten site now fails to compile.
  collections: CollectionMap
): Promise<FirestoreRef | Error> => {
  const pathParts = path.split('/')

  // Use any internally for the building phase, then return typed result
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ref: any = firebaseAdmin().firestore()
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
  collections: CollectionMap,
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
  const ref = await getRef(parts.join('/'), true, collections)
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
 * The substrate `/doc` (mutations) and `/docs` (lists) go through (tosijs-platform#7).
 *
 * `getRef`/`isUnique` (above, moved here from doc.ts unchanged) are injected
 * into the store, so the ported code runs the exact same resolution and
 * uniqueness logic it did before. The port changes who the endpoint talks to,
 * not what it says.
 *
 * Built PER REQUEST rather than once at module load, because `getRef` now has
 * to resolve `field=value` against the collection map for that request — and a
 * module-level store would silently resolve an installed collection's unique
 * key against the platform map, which has no entry for it, and reject every
 * such path as "not an allowed key".
 */
export const firestoreStoreFor = (collections: CollectionMap) =>
  new FirestoreStore({
    getRef: (path, isCollection) => getRef(path, isCollection, collections),
    isUnique: (path, field, value, existing) =>
      isUnique(collections, path, field, value, existing),
  })
