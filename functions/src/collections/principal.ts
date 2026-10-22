/**
 * Who is calling: a bearer credential → the principal's authority.
 *
 * The decision `getUserRoles` made inline in `utilities.ts`, moved into the
 * portable kernel (SOVEREIGN-PLAN.md Phase 1, epic #2863). It reads `role` and
 * `token` documents through the store port and verifies sign-in tokens through
 * an injected function, so the same code serves a Firebase host (Firebase ID
 * tokens, Firestore), a single box (Google ID tokens, SQLite) and a realtime
 * node beside either. It is also, for the first time, testable without an
 * emulator — the assertions about it used to be regexes over `utilities.ts`.
 *
 * Every rule below was a fixed defect; the comments say which.
 */

import type { Store, StoredDoc } from './store'
import { anonymousUser, type UserRoles } from './roles'
import {
  credentialName,
  joinRoleDocs,
  lookupEmail,
  MAX_ROLE_DOCS,
  type RoleRecord,
} from './join-roles'
import {
  TOKEN_PREFIX,
  hashToken,
  tokenAuthority,
  type TokenRecord,
} from '../auth/token'

/** A verified sign-in credential: what an identity provider vouches for. */
export interface Credential {
  uid: string
  email?: string
  email_verified?: boolean
  name?: unknown
  [claim: string]: unknown
}

export interface PrincipalDeps {
  /** Reads `role` and `token`. Nothing here writes (see `findRoleDocs`). */
  store: Pick<Store, 'query'>
  /**
   * Verify a sign-in token. `null` for anything that is not a valid, unrevoked
   * credential — including a transient provider outage: an unverifiable token
   * is anonymous, never trusted by default.
   */
  verify: (idToken: string) => Promise<Credential | null>
  log: { warn: (message: string) => void; error: (message: string) => void }
  /**
   * Called after a signed-in principal resolves with roles. Firebase uses it to
   * sync roles to custom claims for `storage.rules`; other hosts pass nothing.
   */
  onResolved?: (uid: string, roles: string[]) => Promise<void>
  now?: () => number
}

type Row<T> = T & { _id: string; _collection: string }

/**
 * Query a collection the way `getRecords` did: newest first, bounded, with
 * soft-deleted documents dropped AFTER the bound (as before, so a host's
 * behaviour does not change with the port).
 */
async function rows<T>(
  store: Pick<Store, 'query'>,
  collection: string,
  where: { equals?: { field: string; value: unknown }; arrayContains?: { field: string; value: unknown } },
  limit: number
): Promise<Array<Row<T>>> {
  const found: StoredDoc[] = await store.query(collection, {
    ...where,
    orderBy: '_created desc',
    limit,
  })
  return found
    .filter((d) => d.data._deleted !== true)
    .map((d) => ({
      ...(d.data as T),
      _id: d.path.split('/').pop() as string,
      _collection: collection,
    }))
}

/**
 * Role documents naming this email as a contact: an equality match on the
 * whole `{type, value}` object, which needs a store that compares objects by
 * content (Firestore does; `MemoryStore` was fixed to, 2026-10-22).
 */
const rolesByEmail = (store: Pick<Store, 'query'>, email: string) =>
  rows<RoleRecord>(
    store,
    'role',
    { arrayContains: { field: 'contacts', value: { type: 'email', value: email } } },
    MAX_ROLE_DOCS
  )

/**
 * Every role document granting authority to this principal: `userIds` first,
 * `contacts` only if that finds nothing. Both are AUTHORITY, neither a cache of
 * the other — the email path used to append the uid to `userIds` during a READ,
 * so removing a uid was silently undone on the next request (#6, B1). Nothing
 * in this module writes.
 */
async function findRoleDocs(
  store: Pick<Store, 'query'>,
  uid: string,
  email?: string
): Promise<Array<Row<RoleRecord>>> {
  const byUid = await rows<RoleRecord>(
    store,
    'role',
    { arrayContains: { field: 'userIds', value: uid } },
    MAX_ROLE_DOCS
  )
  if (byUid.length || !email) return byUid

  const lower = email.toLowerCase()
  const found = await rolesByEmail(store, lower)
  if (found.length || lower === email) return found
  // Stored contacts predating any normalisation may carry the original case.
  return rolesByEmail(store, email)
}

/**
 * A capability token → what it can do RIGHT NOW (B2, #6). The principal's roles
 * are read live on every request, never trusted from mint time, so revoking a
 * human revokes every agent they authorised. Lookup is by hash (the secret is
 * never stored) and by uid only: the email fallback would let a token outlive
 * the uid it was minted against.
 */
async function rolesForToken(
  secret: string,
  deps: PrincipalDeps
): Promise<UserRoles> {
  const [record] = await rows<TokenRecord>(
    deps.store,
    'token',
    { equals: { field: 'hash', value: hashToken(secret) } },
    2
  )
  if (!record) {
    deps.log.warn('rejected an unknown capability token')
    return anonymousUser
  }

  const principal = joinRoleDocs(
    await rows<RoleRecord>(
      deps.store,
      'role',
      { arrayContains: { field: 'userIds', value: record.principalUid } },
      MAX_ROLE_DOCS
    )
  )

  const now = deps.now ?? Date.now
  const authority = tokenAuthority(record, principal.roles, now())
  if (authority.status === 'refused') {
    // Specific in the log, anonymous on the wire.
    deps.log.warn(`token ${record._id} refused: ${authority.reason}`)
    return anonymousUser
  }

  return {
    ...principal,
    // The token's OWNER authenticated, named as they name themselves (#28).
    principal: {
      uid: record.principalUid,
      ...(record.principalName ? { name: record.principalName } : {}),
    },
    // ATTENUATED. Never the principal's roles: that would hand the agent the
    // human's full authority, which is what this design exists to prevent.
    roles: authority.roles,
    token: {
      id: authority.tokenId,
      label: authority.label,
      methods: authority.methods,
      ...(authority.collections ? { collections: authority.collections } : {}),
    },
  }
}

/**
 * The caller's authority, from an `Authorization` header value.
 *
 * A capability token is self-identifying by prefix, so the two credential kinds
 * are never told apart by trying one and falling back. No header, or no
 * `Bearer`, costs nothing: public and SSR traffic never reaches `verify`.
 */
export async function resolvePrincipal(
  authorization: string | undefined,
  deps: PrincipalDeps
): Promise<UserRoles> {
  const bearer = authorization?.split('Bearer ')[1]
  if (!bearer) return anonymousUser
  if (bearer.startsWith(TOKEN_PREFIX)) return rolesForToken(bearer, deps)

  const credential = await deps.verify(bearer)
  if (!credential) return anonymousUser

  // Only a VERIFIED email may resolve a role by contact (M1): with email
  // sign-in enabled anyone can create an account under any address.
  const docs = await findRoleDocs(deps.store, credential.uid, lookupEmail(credential))
  if (docs.length >= MAX_ROLE_DOCS) {
    deps.log.error(
      `role lookup for ${credential.uid} hit the ${MAX_ROLE_DOCS}-document bound — ` +
        `authority may be incomplete`
    )
  }
  const userRole = joinRoleDocs(docs, (m) => deps.log.warn(m))

  // No role document: stay the shared anonymous identity (compared by
  // reference elsewhere).
  if (userRole === anonymousUser) return userRole

  if (userRole.roles?.length > 0) {
    await deps.onResolved?.(credential.uid, userRole.roles)
  }

  // Who AUTHENTICATED, from the verified credential — not the first uid on the
  // matched role document, which for a contact match or a shared document is
  // someone else (#28). Never the email (0.2.1 review, B2).
  const name = credentialName(credential)
  return {
    ...userRole,
    principal: { uid: credential.uid, ...(name ? { name } : {}) },
  }
}
