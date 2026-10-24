/**
 * The claim ceremony's two transactions, over the store port
 * (SOVEREIGN-PLAN.md Phase 1).
 *
 * Moved from `claim.ts` (now the Firebase binding) unchanged in what it does.
 * `decideClaim` (`claim.ts` beside this) decides; this reads the state, applies
 * the decision and rotates, all in ONE transaction. Without that, two callers
 * posting simultaneously against one valid proof both read `proof === nonce`
 * and both grant; and a crash between grant and rotation would leave a live
 * proof in the datastore (a standing back door) or a rotated nonce with nobody
 * granted.
 *
 * Bodies are retry-safe (the store may re-run them): the clock, the nonces and
 * the new document ids are drawn once, outside the transaction.
 */
import type { Store } from '../collections/store'
import { ROLES } from '../collections/roles'
import { credentialName, lookupEmail } from '../collections/join-roles'
import {
  CLAIM_PATH,
  NONCE_TTL_MS,
  decideClaim,
  hasBeenClaimed,
  rotatedState,
  type ClaimDecision,
  type ClaimState,
} from './claim'

export interface CeremonyDeps {
  now?: () => number
  /** A fresh, unguessable nonce. */
  nonce: () => string
  /** A fresh document id in `collection` (Firestore: an auto-id). */
  newId: (collection: string) => string
}

/** Who is claiming: the verified credential, as `getUser` returns it. */
export interface Claimant {
  uid: string
  email?: string
  email_verified?: boolean
  name?: unknown
  [claim: string]: unknown
}

const isFresh = (state: ClaimState | null, now: number): boolean => {
  if (!state?.nonce || !state.issuedAt) return false
  const issued = Date.parse(state.issuedAt)
  return Number.isFinite(issued) && now - issued <= NONCE_TTL_MS
}

const readState = async (tx: { get: Store['get'] }) => {
  const snapshot = await tx.get(CLAIM_PATH)
  return snapshot.exists ? (snapshot.data as ClaimState) : null
}

/**
 * Publish a nonce, minting one only if there isn't a fresh one.
 *
 * Deliberately NOT "mint on every GET". An unauthenticated caller can hit this
 * endpoint freely, and a fresh nonce on every request means an attacker can
 * rotate the nonce out from under a legitimate claimant between the moment they
 * read it and the moment they finish writing it into the console — turning an
 * open read into a denial of the ceremony. Reusing a live nonce costs nothing,
 * because the nonce is public and proves nothing on its own.
 */
export function publishNonce(
  store: Pick<Store, 'transaction'>,
  deps: Pick<CeremonyDeps, 'now' | 'nonce'>
): Promise<ClaimState> {
  const now = (deps.now ?? Date.now)()
  const nonce = deps.nonce()
  return store.transaction(async (tx) => {
    const state = await readState(tx)
    if (isFresh(state, now)) return state as ClaimState

    const next: ClaimState = {
      ...(state ?? {}),
      nonce,
      issuedAt: new Date(now).toJSON(),
    }
    // A re-mint clears any stale proof. Otherwise a proof written against the
    // PREVIOUS nonce would sit there, and if a nonce ever repeated it would
    // match — a replay this ceremony has no other defence against.
    delete next.proof
    // …and any binding written with it: `for` belongs to one arming.
    delete next.for
    tx.set(CLAIM_PATH, next as Record<string, unknown>)
    return next
  })
}

export type ClaimOutcome =
  | Extract<ClaimDecision, { status: 'refused' }>
  | (Extract<ClaimDecision, { status: 'granted' }> & { reclaim: boolean })

/**
 * Run the claim: decide, grant `configurator`, rotate the nonce and log — all
 * or nothing. Returns the decision; the caller answers (generically on the
 * wire, specifically in the log).
 */
export function claimConfigurator(
  store: Pick<Store, 'transaction'>,
  user: Claimant,
  deps: CeremonyDeps
): Promise<ClaimOutcome> {
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toJSON()
  const nextNonce = deps.nonce()
  const roleId = deps.newId('role')
  const logId = deps.newId('install-log')
  return store.transaction(async (tx) => {
    // All reads before any write — a transaction rule, and the reason the role
    // lookup happens up here rather than next to the grant.
    const state = await readState(tx)
    const existingRoles = await tx.query('role', {
      arrayContains: { field: 'userIds', value: user.uid },
      orderBy: '~',
      limit: 1,
    })

    const decision = decideClaim({
      state,
      principal: user.uid,
      // VERIFIED email only (lookupEmail): an unverified one is a claim, not
      // an identity, and `for` is authority.
      principalEmail: lookupEmail(user) ?? null,
      now,
    })
    if (decision.status === 'refused') return decision

    const reclaim = hasBeenClaimed(state)

    // Grant `configurator` on the caller's existing role document, or make
    // one. Written directly, NOT through /doc: `role` is owner-only (D4), and
    // this is a privileged internal write of the same kind the principal
    // resolver already performs.
    const roleDoc = existingRoles[0]
    if (roleDoc) {
      const roles = (roleDoc.data.roles ?? []) as string[]
      if (!roles.includes(ROLES.configurator)) {
        tx.set(
          roleDoc.path,
          { roles: [...roles, ROLES.configurator], _modified: nowIso },
          { merge: true }
        )
      }
    } else {
      // A contact is authority (role lookup matches on it), so only a
      // VERIFIED email may be recorded as one — the same rule as M1. The
      // grant itself rides on the uid either way.
      const contactEmail = lookupEmail(user)
      tx.set(`role/${roleId}`, {
        // Never the email: a role document's name is what "curated when
        // owned" publishes as `_by.name` (0.2.1 re-review). The display name
        // if there is one; otherwise a neutral label an operator can edit.
        // Role names are UNIQUE, so the fallback carries a uid prefix (the
        // uid is already public in `_by.uid`); a constant would collide on a
        // second claimer and block edits to both documents.
        name: credentialName(user) ?? `Host owner ${user.uid.slice(0, 8)}`,
        contacts: contactEmail ? [{ type: 'email', value: contactEmail }] : [],
        roles: [ROLES.configurator],
        userIds: [user.uid],
        _created: nowIso,
        _modified: nowIso,
      })
    }

    // Rotate in the SAME transaction. `decideClaim` returns `rotate: true` as
    // a requirement, not advice: an unrotated proof stays valid and the next
    // authenticated caller claims for free.
    tx.set(
      CLAIM_PATH,
      rotatedState(state as ClaimState, nextNonce, user.uid, nowIso) as Record<string, unknown>
    )

    tx.set(`install-log/${logId}`, {
      at: nowIso,
      by: user.uid,
      action: reclaim ? 'claim-again' : 'claim',
      granted: ROLES.configurator,
    })

    return { ...decision, reclaim }
  })
}
