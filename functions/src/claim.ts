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

This file is the plumbing. Every decision lives in `decideClaim`; the
transactions that apply it live in `install/claim-ceremony.ts`, over the store
port.

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

import { PAGE_HEADERS } from './page-csp'
import type { Handler } from './http'
import { log } from './log'
import { randomUUID } from 'crypto'

import { optionsResponse, getUser, AuthenticatedRequest } from './utilities'
import { Response } from 'express'
import { NONCE_TTL_MS } from './install/claim'
import { claimConfigurator, publishNonce } from './install/claim-ceremony'
import { firestoreStore } from './adapters/firebase/firestore-store'
import { newDocId } from './collections/store'
import { ROLES } from './collections/roles'
import { claimPage } from './claim-page'
import { fail, noStore } from './errors'

/**
 * `system:claim/current` (`CLAIM_PATH`), split for the instructions below. Not
 * a registered collection — see epoch.ts.
 */
const CLAIM = { collection: 'system:claim', doc: 'current' }
/** The field the claimant writes the nonce into, by hand, in the datastore. */
const PROOF_FIELD = 'proof'

/** The Firebase binding of the ceremony's dependencies. */
const ceremonyDeps = {
  nonce: randomUUID,
  newId: () => newDocId(),
}

export const handleClaim: Handler = async (request, response: Response) => {
  // A platform API response is about the caller who asked — never shared
  // by a CDN (#27). Set FIRST, so it also covers an uncaught throw and the
  // rate-limit / method refusals inside optionsResponse. A handler that is
  // genuinely public may override it.
  noStore(response)
  const req = request as AuthenticatedRequest
  if (optionsResponse(req, response, ['OPTIONS', 'GET', 'POST'])) {
    return
  }

  // The one-click page (board #2489): sign in, click Claim. It grants nothing
  // by itself — the POST below still requires the proof to have been written
  // into the datastore, and (when armed that way) the right verified email.
  if (req.method === 'GET' && 'page' in req.query) {
    // The same strict CSP as the other function-served pages.
    response.set(PAGE_HEADERS)
    response.status(200).type('html').send(claimPage())
    return
  }

  if (req.method === 'GET') {
    try {
      const state = await publishNonce(firestoreStore, ceremonyDeps)
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
      log.error('claim: failed to publish nonce', e)
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
    const outcome = await claimConfigurator(firestoreStore, user, ceremonyDeps)

    if (outcome.status === 'refused') {
      // Specific in the log, generic on the wire. See the header.
      log.warn(
        `claim refused for ${user.uid}: ${outcome.reason}`
      )
      fail(response, 403, 'refused', 'claim refused')
      return
    }

    log.info(
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
    log.error('claim: transaction failed', e)
    fail(response, 500, 'internal', 'claim unavailable')
  }
}
