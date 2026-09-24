/**
# /token endpoint — scoped capability tokens for agents (B2, #6)

## methods
- `GET` lists the caller's own tokens (never the secrets — they do not exist)
- `POST` mints one; body `{ label, caveats: { roles, methods?, collections? }, ttlMs? }`
- `DELETE ?id=<tokenId>` revokes one

Every decision is in `token.ts` and is pure. This file authenticates, reads what
the decision needs, and writes what it returns.

## The secret is shown ONCE

Only a sha256 is stored, so the secret cannot be recovered — not by an operator,
not by a support request, not by whoever reads the datastore. A lost token is
re-minted, never retrieved. That is the property that makes the `token`
collection safe to hold at all, and it is why `GET` can list freely.

## Listing and revoking are scoped to the caller in CODE

`token` is registered with no access for anyone, so `/doc` and `/docs` refuse it
entirely. The declarative visibility vocabulary is row-relative rather than
caller-relative — `{field: 'principalUid', op: 'eq', value: …}` needs a literal,
and the correct literal differs per caller — so a `read` grant to any role would
expose every principal's tokens to that role. The filter therefore lives here.
*/

import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'

import {
  optionsResponse,
  getUser,
  getUserRoles,
  AuthenticatedRequest,
} from '../utilities'
import { Response } from 'express'
import {
  decideMint,
  hashToken,
  newTokenSecret,
  MAX_TTL_MS,
  type TokenRecord,
} from './token'
import { fail, noStore } from '../errors'

const TOKENS = 'token'
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

const db = () => admin.firestore()

export const token = onRequest({}, async (request, response: Response) => {
  // A platform API response is about the caller who asked — never shared
  // by a CDN (#27). Set FIRST, so it also covers an uncaught throw and the
  // rate-limit / method refusals inside optionsResponse. A handler that is
  // genuinely public may override it.
  noStore(response)
  const req = request as AuthenticatedRequest
  if (optionsResponse(req, response, ['OPTIONS', 'GET', 'POST', 'DELETE'])) {
    return
  }

  const userRoles = await getUserRoles(req)
  if (!userRoles.roles.length) {
    fail(response, 401, 'unauthenticated', 'authentication required')
    return
  }

  // Minting needs the uid from the TOKEN, and needs to know whether the caller
  // is a human session or an agent — `userRoles.token` is set only in the
  // latter case, and a token may not mint another token.
  const viaToken = Boolean(userRoles.token)
  const user = viaToken ? false : await getUser(req)
  const uid = viaToken ? userRoles.userIds[0] : user ? user.uid : ''
  if (!uid) {
    fail(response, 401, 'unauthenticated', 'authentication required')
    return
  }

  try {
    switch (req.method) {
      case 'GET': {
        const snapshot = await db()
          .collection(TOKENS)
          .where('principalUid', '==', uid)
          .get()
        response.json({
          tokens: snapshot.docs.map((d) => {
            const t = d.data() as TokenRecord
            return {
              id: d.id,
              label: t.label,
              caveats: t.caveats,
              expiresAt: t.expiresAt,
              createdAt: t.createdAt,
              ...(t.revokedAt ? { revokedAt: t.revokedAt } : {}),
            }
          }),
        })
        return
      }

      case 'POST': {
        const decision = decideMint({
          principalUid: uid,
          // Live, not from a session claim. `decideMint` refuses to delegate
          // what the principal does not currently hold.
          principalRoles: userRoles.roles,
          viaToken,
          label: String(req.body?.label ?? ''),
          caveats: req.body?.caveats,
          ttlMs: Number(req.body?.ttlMs ?? DEFAULT_TTL_MS),
          nowIso: new Date().toJSON(),
        })

        if (decision.status === 'refused') {
          fail(response, 403, 'refused', 'the mint was refused', {
            problems: decision.problems,
          })
          return
        }

        const secret = newTokenSecret()
        const ref = db().collection(TOKENS).doc()
        await ref.set({
          ...decision.record,
          hash: hashToken(secret),
          // `_created` so the same indexed ordering every other collection
          // uses applies here too — `getRecords` appends it unconditionally.
          _created: decision.record.createdAt,
          _modified: decision.record.createdAt,
        })

        functions.logger.info(
          `token minted for ${uid}: "${decision.record.label}" ` +
            `roles=${decision.record.caveats.roles.join(',')}`
        )
        response.json({
          status: 'minted',
          id: ref.id,
          // The only time this value exists anywhere outside the caller's
          // process. Not recoverable — only a hash is stored.
          secret,
          label: decision.record.label,
          caveats: decision.record.caveats,
          expiresAt: decision.record.expiresAt,
          note: 'store this now — it cannot be shown again',
        })
        return
      }

      case 'DELETE': {
        const id = String(req.query.id ?? '')
        if (!id) {
          fail(response, 400, 'bad-request', 'expected ?id=<tokenId>')
          return
        }
        const ref = db().collection(TOKENS).doc(id)
        const existing = await ref.get()
        // Scoped to the caller's own, and OPAQUE about anyone else's: a 403
        // for a token belonging to somebody else would confirm the id exists.
        if (!existing.exists || (existing.data() as TokenRecord).principalUid !== uid) {
          fail(response, 404, 'not-found', 'no such token')
          return
        }
        // Tombstoned, not deleted — the record of which agent made which
        // writes has to outlive the credential, or the provenance a token
        // carries (#6) becomes unresolvable the moment it is revoked.
        await ref.update({
          revokedAt: new Date().toJSON(),
          _modified: new Date().toJSON(),
        })
        functions.logger.info(`token ${id} revoked by ${uid}`)
        response.json({ status: 'revoked', id })
        return
      }

      default:
        fail(response, 400, 'bad-request', 'bad request type')
    }
  } catch (e) {
    functions.logger.error(`token: ${req.method} failed`, e)
    fail(response, 500, 'internal', 'token request failed')
  }
})

export { MAX_TTL_MS }
