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
  decideStart,
  decideApprove,
  decideExchange,
  loopbackRedirect,
  AUTHORIZE_COLLECTION,
  POLL_INTERVAL_MS,
  type AuthorizeRequest,
} from './authorize'
import { decideMint, hashToken, newTokenSecret } from './token'
import { consentPage } from './consent-page'
import { fail } from '../errors'

const db = () => admin.firestore()
const requests = () => db().collection(AUTHORIZE_COLLECTION)

const selfUrl = (req: AuthenticatedRequest): string => {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host
  return `https://${host}/authorize`
}

export const authorize = onRequest({}, async (request, response: Response) => {
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
      response.json(await webConfig())
      return
    }

    // --- the consent page ---------------------------------------------------
    //
    // Every OTHER GET. Checked after `config` above, because this branch
    // answers any GET at all and would otherwise swallow it.
    if (req.method === 'GET') {
      const id = String(req.query.request ?? '')
      const snapshot = id ? await requests().doc(id).get() : null
      const record = snapshot?.exists
        ? ({ ...snapshot.data(), _id: snapshot.id } as AuthorizeRequest)
        : null

      response.set(
        'Content-Security-Policy',
        "default-src 'none'; " +
          "script-src 'unsafe-inline' https://www.gstatic.com; " +
          "connect-src https://*.googleapis.com https://*.google.com 'self'; " +
          "style-src 'unsafe-inline'; frame-src https://*.firebaseapp.com"
      )
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
      const ref = requests().doc()
      await ref.set(decision.record)
      functions.logger.info(
        `authorize: started ${ref.id} (${decision.record.mode}) for "${decision.record.label}"`
      )
      response.json({
        status: 'started',
        requestId: ref.id,
        consentUrl: `${selfUrl(req)}?request=${ref.id}`,
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
      const ref = requests().doc(id)
      const snapshot = id ? await ref.get() : null
      const record = snapshot?.exists
        ? ({ ...snapshot.data(), _id: snapshot.id } as AuthorizeRequest)
        : null

      if (req.body?.approve === false) {
        if (record?.status === 'pending') await ref.update({ status: 'denied' })
        response.json({ status: 'denied' })
        return
      }

      const now = new Date()
      const decision = decideApprove(record, user.uid, now.getTime(), now.toJSON())
      if (decision.status === 'refused') {
        functions.logger.warn(`authorize: approve refused (${decision.reason})`)
        fail(response, 400, 'refused', `authorization ${decision.reason}`, {
          reason: decision.reason,
        })
        return
      }
      await ref.update(decision.patch)
      functions.logger.info(`authorize: ${id} approved by ${user.uid}`)
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
      const ref = requests().doc(id)
      const snapshot = id ? await ref.get() : null
      const record = snapshot?.exists
        ? ({ ...snapshot.data(), _id: snapshot.id } as AuthorizeRequest)
        : null

      const decision = decideExchange(record, verifier, Date.now())
      if (decision.status === 'pending') {
        response.json({ status: 'pending', pollIntervalMs: POLL_INTERVAL_MS })
        return
      }
      if (decision.status === 'refused') {
        functions.logger.warn(`authorize: exchange refused (${decision.reason})`)
        // Specific in the log, generic on the wire — the four reasons together
        // describe the state of a request to somebody who does not hold the
        // verifier for it.
        fail(response, 403, 'refused', 'refused')
        return
      }

      // Mint HERE, from the approver's live roles — not at approval time. A
      // revocation between approving and collecting therefore takes effect.
      const principal = await rolesOf(decision.principalUid)
      const mint = decideMint({
        principalUid: decision.principalUid,
        principalRoles: principal,
        viaToken: false,
        label: decision.label,
        caveats: decision.caveats,
        ttlMs: decision.ttlMs,
        nowIso: new Date().toJSON(),
      })
      if (mint.status === 'refused') {
        response
          .status(403)
          .json({ error: 'refused', message: 'the mint was refused', problems: mint.problems })
        return
      }

      const secret = newTokenSecret()
      const tokenRef = db().collection('token').doc()
      const createdAt = mint.record.createdAt
      // Consume the request in the same batch that creates the token, so a
      // crash cannot leave a request that is still exchangeable for a second
      // credential.
      const batch = db().batch()
      batch.set(tokenRef, {
        ...mint.record,
        hash: hashToken(secret),
        _created: createdAt,
        _modified: createdAt,
      })
      batch.update(ref, { usedAt: createdAt })
      await batch.commit()

      functions.logger.info(
        `authorize: ${id} exchanged — token ${tokenRef.id} for ${decision.principalUid}`
      )
      response.json({
        status: 'ready',
        id: tokenRef.id,
        secret,
        label: mint.record.label,
        caveats: mint.record.caveats,
        expiresAt: mint.record.expiresAt,
      })
      return
    }

    fail(response, 400, 'bad-request', 'unknown action')
  } catch (e) {
    functions.logger.error(`authorize: ${req.method} failed`, e)
    fail(response, 500, 'internal', 'authorization failed')
  }
})

let cachedConfig: Record<string, unknown> | null = null

/** The Firebase web config for this project, from the Firebase Management API. */
async function webConfig(): Promise<Record<string, unknown>> {
  if (cachedConfig) return cachedConfig
  const projectId =
    process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? ''
  const credential = admin.app().options.credential
  const accessToken = await credential?.getAccessToken()
  const res = await fetch(
    `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps/-/config`,
    { headers: { Authorization: `Bearer ${accessToken?.access_token}` } }
  )
  if (!res.ok) {
    throw new Error(`could not read the web config: ${res.status}`)
  }
  cachedConfig = (await res.json()) as Record<string, unknown>
  return cachedConfig
}

/** The principal's roles, read live. Same shape `getUserRoles` uses. */
async function rolesOf(uid: string): Promise<string[]> {
  const { getRecords } = await import('../utilities')
  const { joinRoleDocs, MAX_ROLE_DOCS } = await import('../collections/join-roles')
  const docs = await getRecords('role', 'userIds', 'array-contains', uid, MAX_ROLE_DOCS)
  return joinRoleDocs(docs as never).roles
}
