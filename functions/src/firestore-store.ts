/**
 * The Firestore implementation of the substrate port (tosijs-platform#7).
 *
 * Lives OUTSIDE `collections/` on purpose: `collections/` is the portable
 * decision kernel (it is what `service-compris` publishes) and imports nothing
 * from firebase. The vendor binding belongs here.
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
 * Injection also keeps the dependency acyclic: `doc.ts` owns those primitives
 * and constructs the store, so this module never imports `doc.ts`. Moving them
 * here would be tidier and is worth doing when the read path lands, at which
 * point `doc.ts` stops needing them directly.
 */
import * as admin from 'firebase-admin'

import type { Store, StoredDoc, QueryOptions } from './collections/store'
import { physicalPath } from './collections/namespace'

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
    // Canonicalize: getRef has already turned `field=value` into a concrete
    // document, so rebuild the path from the resolved id.
    const collection = parts.filter((_, i) => i % 2 === 0).join('/')
    return `${collection}/${(ref as DocRef).id}`
  }

  private ref(path: string): DocRef {
    // Logical -> physical. The identity function today (`:` is a legal Firestore
    // collection id), so this changes nothing and stored data is untouched. It
    // is applied HERE so that a substrate whose naming rules differ — Postgres
    // table names cannot contain `:` — is a change in namespace.ts and nowhere
    // else. See tosijs-platform#7.
    const parts = physicalPath(path).split('/')
    let ref: FirebaseFirestore.Firestore | DocRef =
      admin.firestore() as FirebaseFirestore.Firestore
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
export async function firestoreQuery(
  collection: string,
  options: QueryOptions = {}
): Promise<StoredDoc[]> {
  let ref: FirebaseFirestore.Query = admin
    .firestore()
    .collection(physicalPath(collection))
  if (options.equals) {
    ref = ref.where(options.equals.field, '==', options.equals.value)
  }
  if (options.arrayContains) {
    ref = ref.where(options.arrayContains.field, 'array-contains', options.arrayContains.value)
  }
  const [field, direction] = (options.orderBy ?? '_created desc').split(' ')
  if (field !== '~') {
    ref = ref.orderBy(field, direction === 'desc' ? 'desc' : 'asc')
  }
  if (options.limit) ref = ref.limit(options.limit)
  const snapshot = await ref.get()
  return snapshot.docs.map((d) => ({
    path: `${collection}/${d.id}`,
    exists: true,
    data: d.data() as Record<string, unknown>,
  }))
}
