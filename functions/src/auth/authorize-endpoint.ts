/**
# /authorize — the browser loop that gives a CLI its first token (B2, #6)

## actions
- `POST ?action=start`    (no auth) begin a request; returns `requestId` + consent URL
- `GET  ?request=<id>`    the consent page a human opens
- `POST ?action=approve`  (authenticated) record who approved; body `{ requestId, approve }`
- `POST ?action=exchange` (no auth) `{ requestId, verifier }` → `pending` or the token

Every decision is in `authorize.ts` and is pure.

## The consent page is served BY this function

Not by hosting. Three reasons, in order of weight:

1. a page that authorises credentials should ship with the code that processes
   it — two deploys means they can desync, and the window where they disagree
   is a security window;
2. hosting's catch-all is `** → prefetch`, which ROADMAP Phase 2 removes;
3. it needs no hosting deploy at all, so this lands without touching a live
   site.

The cost is a CSP that permits Google's auth SDK from gstatic, which is named
explicitly below rather than left to a default.

## What this endpoint will not do

It never returns a token to the browser, and it never stores one. Approval
records *who*; the exchange mints from that principal's LIVE roles and hands
the secret straight to the CLI. So a revocation between approving and
collecting takes effect, and the "no secret is ever stored" property survives.
*/

import { PAGE_HEADERS } from '../page-csp'
import type { Handler } from '../http'
import { identity } from '../identity'
import { log } from '../log'

import {
  optionsResponse,
  getUser,
  getUserRoles,
  AuthenticatedRequest,
} from '../utilities'
import { Response } from 'express'
import {
  decideStart,
  loopbackRedirect,
  AUTHORIZE_COLLECTION,
  POLL_INTERVAL_MS,
} from './authorize'
import { storeSweepable, sweepExpired } from '../sweep'
import { dataStore } from '../datastore'
import { approveRequest, denyRequest, exchangeRequest, readRequest } from './authorize-store'
import { createDocument, newDocId } from '../collections/store'
import { consentPage } from './consent-page'
import { fail, noStore } from '../errors'
import { credentialName } from '../collections/join-roles'


const selfUrl = (req: AuthenticatedRequest): string => {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host
  return `https://${host}/authorize`
}

export const handleAuthorize: Handler = async (request, response: Response) => {
  // A platform API response is about the caller who asked — never shared
  // by a CDN (#27). Set FIRST, so it also covers an uncaught throw and the
  // rate-limit / method refusals inside optionsResponse. A handler that is
  // genuinely public may override it.
  noStore(response)
  const req = request as AuthenticatedRequest
  if (optionsResponse(req, response, ['OPTIONS', 'GET', 'POST'])) {
    return
  }

  const action = String(req.query.action ?? '')

  try {
    // --- the web config the consent page needs ------------------------------
    //
    // Fetched from the project itself with the function's own credentials
    // rather than stored anywhere. It is public information (it ships in every
    // web bundle), but deriving it means this works on a freshly provisioned
    // host with nothing configured — which is the whole premise of #5.
    if (action === 'config') {
      response.set('Cache-Control', 'public, max-age=3600')
      response.json(await identity().webConfig())
      return
    }

    // --- the consent page ---------------------------------------------------
    //
    // Every OTHER GET. Checked after `config` above, because this branch
    // answers any GET at all and would otherwise swallow it.
    if (req.method === 'GET') {
      const id = String(req.query.request ?? '')
      const record = await readRequest(dataStore, id)

      response.set(PAGE_HEADERS)
      // Never cached: it renders a live, expiring authorization request.
      response.set('Cache-Control', 'no-store')
      response.status(record ? 200 : 404).send(consentPage(record, id))
      return
    }

    // --- start --------------------------------------------------------------
    if (action === 'start') {
      const decision = decideStart({
        label: req.body?.label,
        caveats: req.body?.caveats,
        codeChallenge: req.body?.codeChallenge,
        mode: req.body?.mode,
        redirectPort: req.body?.redirectPort,
        ttlMs: req.body?.ttlMs,
        nowIso: new Date().toJSON(),
      })
      if (decision.status === 'refused') {
        fail(response, 400, 'refused', 'the request was refused', {
          problems: decision.problems,
        })
        return
      }
      // Starting is anonymous, so it cleans up after itself (sweep.ts): the
      // same rule as install proposals, best effort.
      await sweepExpired(storeSweepable(dataStore, AUTHORIZE_COLLECTION), Date.now(), (e) =>
        log.warn('authorize: sweeping expired requests failed', e)
      )
      const requestId = newDocId()
      await createDocument(
        dataStore,
        `${AUTHORIZE_COLLECTION}/${requestId}`,
        decision.record as unknown as Record<string, unknown>
      )
      log.info(
        `authorize: started ${requestId} (${decision.record.mode}) for "${decision.record.label}"`
      )
      response.json({
        status: 'started',
        requestId,
        consentUrl: `${selfUrl(req)}?request=${requestId}`,
        expiresAt: decision.record.expiresAt,
        pollIntervalMs: POLL_INTERVAL_MS,
      })
      return
    }

    // --- approve / deny -----------------------------------------------------
    if (action === 'approve') {
      const userRoles = await getUserRoles(req)
      const user = await getUser(req)
      if (!user || userRoles.token) {
        // A token may not approve an authorization: that would let one agent
        // credential manufacture another, which is the loop `decideMint`
        // already refuses directly.
        fail(response, 401, 'unauthenticated', 'a signed-in human is required')
        return
      }

      const id = String(req.body?.requestId ?? '')

      if (req.body?.approve === false) {
        // Only while still pending (authorize-store.ts): a denial must not
        // overwrite an approval that landed first.
        await denyRequest(dataStore, id)
        response.json({ status: 'denied' })
        return
      }

      // Decided on the request as stored at commit, so two approvals (or an
      // approval racing a denial) cannot both land.
      const { decision, record } = await approveRequest(
        dataStore,
        id,
        { uid: user.uid, name: credentialName(user) },
        new Date()
      )
      if (decision.status === 'refused') {
        log.warn(`authorize: approve refused (${decision.reason})`)
        fail(response, 400, 'refused', `authorization ${decision.reason}`, {
          reason: decision.reason,
        })
        return
      }
      log.info(`authorize: ${id} approved by ${user.uid}`)
      response.json({
        status: 'approved',
        // The page needs this to close the loopback loop; it carries no
        // credential — the CLI still needs the verifier to get anything.
        redirect:
          record?.mode === 'loopback' && record.redirectPort
            ? loopbackRedirect(record.redirectPort, id)
            : null,
      })
      return
    }

    // --- exchange -----------------------------------------------------------
    if (action === 'exchange') {
      const id = String(req.body?.requestId ?? '')
      const verifier = String(req.body?.verifier ?? '')
      // Mints from the approver's LIVE roles, and consumes the request in the
      // same transaction as the mint — at most one token per request, even
      // when two exchanges race (authorize-store.ts).
      const outcome = await exchangeRequest(dataStore, id, verifier, { rolesOf })
      if (outcome.status === 'pending') {
        response.json({ status: 'pending', pollIntervalMs: POLL_INTERVAL_MS })
        return
      }
      if (outcome.status === 'refused') {
        log.warn(`authorize: exchange refused (${outcome.reason})`)
        // Specific in the log, generic on the wire — the reasons together
        // describe the state of a request to somebody who does not hold the
        // verifier for it.
        fail(response, 403, 'refused', 'refused')
        return
      }
      if (outcome.status === 'mint-refused') {
        response
          .status(403)
          .json({ error: 'refused', message: 'the mint was refused', problems: outcome.problems })
        return
      }

      log.info(
        `authorize: ${id} exchanged — token ${outcome.tokenId} for ${outcome.principalUid}`
      )
      response.json({
        status: 'ready',
        id: outcome.tokenId,
        secret: outcome.secret,
        label: outcome.record.label,
        caveats: outcome.record.caveats,
        expiresAt: outcome.record.expiresAt,
      })
      return
    }

    fail(response, 400, 'bad-request', 'unknown action')
  } catch (e) {
    log.error(`authorize: ${req.method} failed`, e)
    fail(response, 500, 'internal', 'authorization failed')
  }
}

/** The principal's roles, read live. Same shape `getUserRoles` uses. */
async function rolesOf(uid: string): Promise<string[]> {
  const { getRecords } = await import('../utilities')
  const { joinRoleDocs, MAX_ROLE_DOCS } = await import('../collections/join-roles')
  const docs = await getRecords('role', 'userIds', 'array-contains', uid, MAX_ROLE_DOCS)
  return joinRoleDocs(docs as never).roles
}
