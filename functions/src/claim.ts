/**
# /claim endpoint — bootstrapping the first `configurator`

## methods
- `GET` publishes the current nonce and says where to write it
- `POST` (authenticated) checks the proof and mints `configurator`

The ceremony, and the reasoning for its shape, is documented in
`install/claim.ts`. In one line: the claimant proves they can WRITE the
datastore, which per D3 already outranks anything this system can enforce, so
it is the strongest claim available to bootstrap from — and nothing secret is
ever published.

This file is the plumbing. Every decision lives in `decideClaim`.

## Two things here that are not in the pure logic

**The whole ceremony runs in one transaction.** Read the claim state, decide,
rotate the nonce and grant the role — atomically. Without that, two callers
posting simultaneously against one valid proof both read `proof === nonce`,
both grant, and the rotation that is supposed to make this one-time happens
twice. A transaction is also what makes rotation and the grant inseparable: a
crash between them would either leave a live proof sitting in the datastore
(a standing back door) or a rotated nonce with nobody granted (a ceremony that
has to be re-run for no reason).

**Refusals are generic on the wire and specific in the log.** `decideClaim`
distinguishes no-nonce / expired / no-proof / mismatch because an operator
reading logs needs to know which invariant failed. An HTTP client does not:
together those four responses narrate the exact state of the ceremony to
somebody who should not be able to observe it at all.
*/

import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import { randomUUID } from 'crypto'

import { optionsResponse, getUser, AuthenticatedRequest } from './utilities'
import { Response } from 'express'
import {
  decideClaim,
  rotatedState,
  hasBeenClaimed,
  NONCE_TTL_MS,
  type ClaimState,
} from './install/claim'
import { ROLES } from './collections/roles'
import { lookupEmail } from './collections/join-roles'
import { fail, noStore } from './errors'

/** `system:claim/current`, split. Not a registered collection — see epoch.ts. */
const CLAIM = { collection: 'system:claim', doc: 'current' }
/** The field the claimant writes the nonce into, by hand, in the datastore. */
const PROOF_FIELD = 'proof'

const claimRef = () =>
  admin.firestore().collection(CLAIM.collection).doc(CLAIM.doc)

const isFresh = (state: ClaimState | null, now: number): boolean => {
  if (!state?.nonce || !state.issuedAt) return false
  const issued = Date.parse(state.issuedAt)
  return Number.isFinite(issued) && now - issued <= NONCE_TTL_MS
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
async function publishNonce(): Promise<ClaimState> {
  const now = Date.now()
  return admin.firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(claimRef())
    const state = (snapshot.data() ?? null) as ClaimState | null
    if (isFresh(state, now)) return state as ClaimState

    const next: ClaimState = {
      ...(state ?? {}),
      nonce: randomUUID(),
      issuedAt: new Date(now).toJSON(),
    }
    // A re-mint clears any stale proof. Otherwise a proof written against the
    // PREVIOUS nonce would sit there, and if a nonce ever repeated it would
    // match — a replay this ceremony has no other defence against.
    delete next.proof
    tx.set(claimRef(), next)
    return next
  })
}

export const claim = onRequest({}, async (request, response: Response) => {
  // A platform API response is about the caller who asked — never shared
  // by a CDN (#27). Set FIRST, so it also covers an uncaught throw and the
  // rate-limit / method refusals inside optionsResponse. A handler that is
  // genuinely public may override it.
  noStore(response)
  const req = request as AuthenticatedRequest
  if (optionsResponse(req, response, ['OPTIONS', 'GET', 'POST'])) {
    return
  }

  if (req.method === 'GET') {
    try {
      const state = await publishNonce()
      response.json({
        nonce: state.nonce,
        expiresAt: new Date(
          Date.parse(state.issuedAt as string) + NONCE_TTL_MS
        ).toJSON(),
        // Where to write it. Said explicitly because the whole point is that
        // this write CANNOT be done through the API — it needs the Firebase
        // console, gcloud, or admin credentials.
        writeTo: {
          collection: CLAIM.collection,
          document: CLAIM.doc,
          field: PROOF_FIELD,
        },
        instructions:
          `Write the nonce into "${PROOF_FIELD}" on ` +
          `${CLAIM.collection}/${CLAIM.doc} using the Firebase console or ` +
          `admin credentials, then POST here with a Bearer token. Being able ` +
          `to make that write is the proof; the nonce itself is public.`,
      })
    } catch (e) {
      functions.logger.error('claim: failed to publish nonce', e)
      fail(response, 500, 'internal', 'claim unavailable')
    }
    return
  }

  // POST — authenticated, because a claim must be attributable.
  const user = await getUser(req)
  if (!user) {
    fail(response, 401, 'unauthenticated', 'authentication required')
    return
  }

  try {
    const outcome = await admin.firestore().runTransaction(async (tx) => {
      // All reads before any write — a Firestore transaction rule, and the
      // reason the role lookup happens up here rather than next to the grant.
      const snapshot = await tx.get(claimRef())
      const state = (snapshot.data() ?? null) as ClaimState | null
      const existingRoles = await tx.get(
        admin
          .firestore()
          .collection('role')
          .where('userIds', 'array-contains', user.uid)
          .limit(1)
      )

      const decision = decideClaim({
        state,
        principal: user.uid,
        now: Date.now(),
      })
      if (decision.status === 'refused') return decision

      const nowIso = new Date().toJSON()
      const reclaim = hasBeenClaimed(state)

      // Grant `configurator` on the caller's existing role document, or make
      // one. Written directly with admin credentials, NOT through /doc: `role`
      // is owner-only (D4), and this is a privileged internal write of the same
      // kind `getUserRoles` already performs.
      const roleDoc = existingRoles.docs[0]
      if (roleDoc) {
        const roles = (roleDoc.data().roles ?? []) as string[]
        if (!roles.includes(ROLES.configurator)) {
          tx.update(roleDoc.ref, {
            roles: [...roles, ROLES.configurator],
            _modified: nowIso,
          })
        }
      } else {
        // A contact is authority (role lookup matches on it), so only a
        // VERIFIED email may be recorded as one — the same rule as M1. The
        // grant itself rides on the uid either way.
        const contactEmail = lookupEmail(user)
        tx.set(admin.firestore().collection('role').doc(), {
          name: user.email ?? user.uid,
          contacts: contactEmail
            ? [{ type: 'email', value: contactEmail }]
            : [],
          roles: [ROLES.configurator],
          userIds: [user.uid],
          _created: nowIso,
          _modified: nowIso,
        })
      }

      // Rotate in the SAME transaction. `decideClaim` returns `rotate: true`
      // as a requirement, not advice: an unrotated proof stays valid and the
      // next authenticated caller claims for free.
      tx.set(
        claimRef(),
        rotatedState(state as ClaimState, randomUUID(), user.uid, nowIso)
      )

      tx.set(admin.firestore().collection('install-log').doc(), {
        at: nowIso,
        by: user.uid,
        action: reclaim ? 'claim-again' : 'claim',
        granted: ROLES.configurator,
      })

      return { ...decision, reclaim }
    })

    if (outcome.status === 'refused') {
      // Specific in the log, generic on the wire. See the header.
      functions.logger.warn(
        `claim refused for ${user.uid}: ${outcome.reason}`
      )
      fail(response, 403, 'refused', 'claim refused')
      return
    }

    functions.logger.info(
      `claim granted to ${user.uid}${outcome.reclaim ? ' (re-claim)' : ''}`
    )
    response.json({
      ok: true,
      granted: ROLES.configurator,
      // No token refresh needed: roles are read live from the `role` collection
      // on every request, not baked into the ID token.
      note: 'the next authenticated request already carries this role',
    })
  } catch (e) {
    functions.logger.error('claim: transaction failed', e)
    fail(response, 500, 'internal', 'claim unavailable')
  }
})
