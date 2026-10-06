/**
# /install endpoint — putting a library onto a host

## methods
- `GET` lists what is installed (grants, versions, capabilities)
- `POST` installs or upgrades; body `{ manifest, approving? }`
- `DELETE ?name=<namespace>` revokes

Requires the `configurator` role — and specifically NOT `owner`. Owner's power
is the datastore (D3), not an in-system bypass; an owner who wants to install
grants themselves `configurator` through `role`, and that grant is visible in
the collection everyone can audit.

Every decision is in `apply.ts` and is pure. This file authenticates, reads what
the decision needs, and commits what it returns. The rule for anything added
here later: if it is a judgement, it belongs in `apply.ts` where it can be
tested without Firebase.

## Why the commit is one batch

The three records are not independent. The grant is what takes effect; the
manifest is the diff basis every FUTURE upgrade's additive-only check reads;
the epoch is how other instances find out. A partial commit is worse than a
failed one in each direction — a grant without a manifest means the next
upgrade has nothing to compare against and sails through, and a config change
without an epoch bump means warm instances enforce the old rules indefinitely
rather than for a few seconds.
*/

import { onRequest } from 'firebase-functions/v2/https'
import { PAGE_HEADERS } from '../page-csp'
import { PUBLIC_ENDPOINT } from '../endpoint-options'
import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import { randomBytes } from 'crypto'
import { unenforcedKeywords } from 'tosijs-schema'
import {
  MAX_LIVE_PROPOSALS,
  SWEEP_BATCH,
  approvingFrom,
  decided,
  denied,
  propose,
  proposalState,
  taken,
  type Proposal,
} from './proposal'
import { proposalPage } from './proposal-page'

import {
  optionsResponse,
  getUser,
  getUserRoles,
  AuthenticatedRequest,
} from '../utilities'
import { Response } from 'express'
import { ROLES } from '../collections/roles'
import {
  decideInstall,
  decideRevoke,
  type Grant,
  type InstallRecords,
} from './apply'
import {
  unenforcedCapabilities,
  supersededCapabilities,
  type Manifest,
  type CapabilityDeclaration,
} from './manifest'
import { bumpEpochIn } from './epoch'
import { sameManifest, ManifestConflict } from './manifest-identity'
import { fail, noStore } from '../errors'

const MANIFESTS = 'manifest'
const GRANTS = 'grant'
const LOG = 'install-log'

const db = () => admin.firestore()

const validateOptions = {
  unenforced: (schema: unknown) =>
    unenforcedKeywords(schema as never) as string[],
  knownRoles: Object.values(ROLES),
}

const readGrant = async (name: string): Promise<Grant | null> => {
  const snapshot = await db().collection(GRANTS).doc(name).get()
  return snapshot.exists ? (snapshot.data() as Grant) : null
}

const readManifest = async (
  name: string,
  version: string | null
): Promise<Manifest | null> => {
  if (!version) return null
  const snapshot = await db().collection(MANIFESTS).doc(`${name}@${version}`).get()
  return snapshot.exists ? (snapshot.data() as Manifest) : null
}

/**
 * Commit the decided records, plus the epoch bump, atomically.
 *
 * ## A version's CONTENT is immutable
 *
 * Manifests are append-only, so a version already on file is never rewritten.
 * But re-submitting one is normal: approving a parked upgrade means POSTing the
 * same manifest again with `approving` set. So the rule is not "you may only
 * send a version once", it is "a version always means the same thing":
 *
 *   - not on file  → written
 *   - on file, identical → nothing to write, proceed
 *   - on file, DIFFERENT → refused, 409
 *
 * That last case is the one worth having. Without it, a library could be
 * reviewed at 1.2.0, parked pending approval, and then have 1.2.0's collections
 * and access rules swapped before the human clicks approve — so what takes
 * effect is not what was read. `approving` already pins the capabilities; this
 * pins everything else.
 */
async function commit(records: InstallRecords): Promise<void> {
  const batch = db().batch()
  if (records.manifest) {
    const ref = db().collection(MANIFESTS).doc(records.manifest.id)
    const existing = await ref.get()
    if (!existing.exists) {
      // `create`, not `set` — so a concurrent install of the same version
      // loses the race loudly instead of silently overwriting.
      batch.create(ref, records.manifest.data)
    } else if (!sameManifest(existing.data(), records.manifest.data)) {
      throw new ManifestConflict(
        `${records.manifest.id} is already on file with different content — ` +
          `a published version may not change. Publish a new version.`
      )
    }
  }
  batch.set(db().collection(GRANTS).doc(records.grant.id), records.grant.data)
  batch.set(db().collection(LOG).doc(records.log.id), records.log.data)
  bumpEpochIn(batch)
  await batch.commit()
}

/** Only present when there is something to say, so existing responses are unchanged. */
const superseded = (m: Manifest) => {
  const list = supersededCapabilities(m)
  return list.length ? { superseded: list } : {}
}

export interface InstallResult {
  httpStatus: number
  /** Set when refused; `body` is set otherwise. */
  error?: string
  message?: string
  extra?: Record<string, unknown>
  body?: Record<string, unknown>
}

/**
 * Install (or upgrade) a manifest as `principal`: the ONE code path, used by
 * `POST /install` and by an approved proposal (board #2490). `dryRun` decides
 * everything and commits nothing, so the approval page can show exactly what
 * would happen before anyone clicks.
 *
 * Throws ManifestConflict (a published version re-posted with other content).
 */
export async function runInstall(input: {
  manifest: unknown
  approving?: Record<string, CapabilityDeclaration>
  principal: { uid: string; roles: readonly string[] }
  dryRun?: boolean
}): Promise<InstallResult> {
  const { manifest, approving, principal, dryRun } = input
  // Read the grant BEFORE trusting the manifest's own name for anything
  // else — `decideInstall` refuses a grant/manifest namespace mismatch.
  const name = (manifest as Manifest | null)?.name
  if (typeof name !== 'string') {
    return {
      httpStatus: 400,
      error: 'refused',
      message: 'manifest has no name',
      extra: { problems: ['manifest has no name'] },
    }
  }
  const existing = await readGrant(name)
  const previousManifest = await readManifest(name, existing?.activeVersion ?? null)

  const decision = decideInstall({
    manifest,
    existing,
    previousManifest,
    principal,
    nowIso: new Date().toJSON(),
    logId: db().collection(LOG).doc().id,
    validate: validateOptions,
    approving,
  })

  if (decision.status === 'refused') {
    return {
      httpStatus: 400,
      error: 'refused',
      message: 'the manifest was refused',
      extra: { problems: decision.problems },
    }
  }

  const from = existing && existing.status !== 'revoked' ? existing.activeVersion : null

  if (decision.status === 'needs-approval') {
    if (!dryRun) {
      await commit(decision.records)
      functions.logger.info(
        `install: ${name} parked pending approval of ${decision.added.length} capability request(s)`
      )
    }
    // 202: recorded, deliberately not applied. The grant still names the
    // OLD version with the OLD capabilities.
    return {
      httpStatus: 202,
      body: {
        status: 'needs-approval',
        name,
        added: decision.added,
        // Says plainly which of these this host cannot yet enforce. An
        // approval prompt that overstates what it is asking about is how
        // people learn to stop reading them.
        unenforced: unenforcedCapabilities(manifest as Manifest),
        ...superseded(manifest as Manifest),
        ...(dryRun ? { from } : {}),
        note:
          'nothing changed. re-POST with `approving` set to exactly these ' +
          'capabilities to apply the upgrade.',
      },
    }
  }

  if (!dryRun) {
    await commit(decision.records)
    functions.logger.info(
      `install: ${decision.status} ${name}@${(manifest as Manifest).version} by ${principal.uid}`
    )
  }
  return {
    httpStatus: 200,
    body: {
      status: decision.status,
      name,
      version: (manifest as Manifest).version,
      unenforced: unenforcedCapabilities(manifest as Manifest),
      ...superseded(manifest as Manifest),
      ...(dryRun ? { from } : {}),
    },
  }
}

const PROPOSALS = 'system:install-proposal'
const proposals = () => db().collection(PROPOSALS)

const readProposal = async (id: string): Promise<Proposal | null> => {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return null
  const snap = await proposals().doc(id).get()
  return snap.exists ? (snap.data() as Proposal) : null
}

/**
 * Propose / view / poll / preview / approve an install (see proposal.ts).
 * Returns true when it answered the request.
 */
async function handleProposal(
  req: AuthenticatedRequest,
  response: Response,
  userRoles: Awaited<ReturnType<typeof getUserRoles>>
): Promise<boolean> {
  const action = String(req.query.action ?? '')
  const requestId = String(req.query.request ?? req.body?.requestId ?? '')

  // The page: every GET that names a request and no action.
  if (req.method === 'GET' && req.query.request && !action) {
    const proposal = await readProposal(requestId)
    response.set(PAGE_HEADERS)
    response
      .status(proposal ? 200 : 404)
      .type('html')
      .send(proposalPage(proposal, proposalState(proposal, Date.now()), requestId))
    return true
  }

  // What the CLI polls. Says only what the proposer already knows, plus the outcome.
  if (req.method === 'GET' && action === 'status') {
    const proposal = await readProposal(requestId)
    const state = proposalState(proposal, Date.now())
    response.status(proposal ? 200 : 404).json({ status: state, ...(proposal?.result ? { result: proposal.result } : {}) })
    return true
  }

  if (req.method !== 'POST' || !['propose', 'preview', 'approve'].includes(action)) return false

  if (action === 'propose') {
    // No credentials: a proposal is inert until a configurator approves it.
    const outcome = propose(req.body?.manifest, Date.now(), randomBytes(8))
    if (outcome.status === 'refused') {
      fail(
        response,
        outcome.reason === 'too-large' ? 413 : 400,
        outcome.reason === 'too-large' ? 'too-large' : 'bad-request',
        outcome.reason === 'too-large' ? 'the manifest is too large to propose' : 'expected { manifest } in the body'
      )
      return true
    }
    // Proposing is anonymous, so it cleans up after itself and is bounded
    // (0.4.0 review B3): delete what has expired, then refuse if too many are
    // still awaiting a decision. `expiresAt` is an ISO string; it sorts as time.
    const nowIso = new Date().toJSON()
    const stale = await proposals().where('expiresAt', '<', nowIso).limit(SWEEP_BATCH).get()
    if (!stale.empty) {
      const batch = db().batch()
      for (const doc of stale.docs) batch.delete(doc.ref)
      await batch.commit()
    }
    const live = await proposals().where('expiresAt', '>=', nowIso).count().get()
    if (live.data().count >= MAX_LIVE_PROPOSALS) {
      fail(
        response,
        429,
        'rate-limited',
        'too many install requests are awaiting a decision on this host; try again in a few minutes'
      )
      return true
    }
    // create, never set: a proposal id can never be overwritten.
    const ref = proposals().doc()
    await ref.create(outcome.proposal)
    const host = req.headers['x-forwarded-host'] ?? req.headers.host
    response.json({
      requestId: ref.id,
      code: outcome.proposal.code,
      url: `https://${host}/install?request=${ref.id}`,
      expiresAt: outcome.proposal.expiresAt,
    })
    return true
  }

  const proposal = await readProposal(requestId)
  const state = proposalState(proposal, Date.now())

  // Denying needs no sign-in: it can only ever stop an install.
  if (action === 'approve' && req.body?.approve === false) {
    if (proposal && state === 'pending') {
      await proposals().doc(requestId).update(denied(new Date().toJSON()))
    }
    response.json({ status: 'denied' })
    return true
  }

  if (!userRoles.roles.includes(ROLES.configurator)) {
    fail(response, 403, 'forbidden', 'installing requires the `configurator` role')
    return true
  }
  const user = await getUser(req)
  if (!user) {
    fail(response, 401, 'unauthenticated', 'authentication required')
    return true
  }
  if (!proposal || state !== 'pending') {
    fail(response, 404, 'not-found', 'no pending install request with that id')
    return true
  }
  const principal = { uid: user.uid, roles: userRoles.roles as readonly string[] }

  const answer = (r: InstallResult) => {
    if (r.error) fail(response, r.httpStatus, r.error as never, r.message ?? '', r.extra ?? {})
    else response.status(200).json(r.body)
  }

  try {
    if (action === 'preview') {
      // Decide everything, commit nothing.
      answer(await runInstall({ manifest: proposal.manifest, principal, dryRun: true }))
      return true
    }

    // approve: single-use. Take the proposal first, in a transaction, so two
    // clicks (or two tabs) cannot both install.
    const took = await db().runTransaction(async (tx) => {
      const snap = await tx.get(proposals().doc(requestId))
      const current = snap.exists ? (snap.data() as Proposal) : null
      if (proposalState(current, Date.now()) !== 'pending') return false
      tx.update(snap.ref, taken(user.uid, new Date().toJSON()))
      return true
    })
    if (!took) {
      fail(response, 404, 'not-found', 'no pending install request with that id')
      return true
    }

    // The STORED manifest, never one from the browser.
    // An upgrade that adds capabilities needs them approved. The page listed
    // every capability the manifest asks for, so approving the proposal approves
    // exactly the ones the host says are outstanding: ask (a dry run, nothing
    // committed), then install approving those.
    const asked = await runInstall({ manifest: proposal.manifest, principal, dryRun: true })
    const approving =
      !asked.error && asked.body?.status === 'needs-approval'
        ? (approvingFrom(asked.body.added) as Record<string, CapabilityDeclaration>)
        : undefined
    let result = await runInstall({ manifest: proposal.manifest, principal, approving })
    // Still outstanding (the grant changed between the two reads): that is NOT
    // an install, and must never be recorded or reported as one.
    if (!result.error && result.body?.status === 'needs-approval') {
      result = {
        httpStatus: 409,
        error: 'conflict',
        message: 'the upgrade still needs capabilities approved; nothing was applied. Propose it again.',
      }
    }
    await proposals()
      .doc(requestId)
      .update(
        decided(
          result.error
            ? { failure: { error: result.error, message: result.message ?? '', ...(result.extra ?? {}) } }
            : { body: result.body }
        )
      )
    answer(result)
  } catch (e) {
    const conflict = e instanceof ManifestConflict
    await proposals()
      .doc(requestId)
      .update(decided({ failure: { error: conflict ? 'conflict' : 'internal', message: conflict ? e.message : 'install failed' } }))
      .catch(() => undefined)
    if (conflict) fail(response, 409, 'conflict', e.message)
    else {
      functions.logger.error('install: approving a proposal failed', e)
      fail(response, 500, 'internal', 'install failed')
    }
  }
  return true
}

export const install = onRequest(PUBLIC_ENDPOINT, async (request, response: Response) => {
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

  // Install proposals (board #2490): propose without credentials, approve in
  // the browser. Handled before the configurator-only paths below.
  if (await handleProposal(req, response, userRoles)) return

  // `GET ?name=<namespace>` — "is this library installed, and at which
  // version?" (#19).
  //
  // Answerable by ANY authenticated principal, tokens included, because the
  // alternative leaves an agent with no way to ask. `configurator` can never
  // be carried by a token (rightly), so the full listing is closed to one —
  // and a collection that is missing and a collection outside the token's
  // caveats both answer an opaque 404, so the agent cannot tell "not
  // installed" from "not mine". That is a diagnosis it has to be able to
  // make: the alternative is a schema rejection three requests later.
  //
  // It discloses only what a caller could already infer by writing to the
  // collection: name, version, status. Nothing about capabilities, nothing
  // about other libraries.
  if (req.method === 'GET' && req.query.name) {
    if (!userRoles.roles.length) {
      fail(response, 401, 'unauthenticated', 'authentication required')
      return
    }
    const name = String(req.query.name)
    const grant = await readGrant(name)
    if (!grant || grant.status === 'revoked') {
      fail(response, 404, 'not-found', `nothing installed as "${name}"`)
      return
    }
    response.json({
      name: grant.name,
      version: grant.activeVersion,
      status: grant.status,
    })
    return
  }

  if (!userRoles.roles.includes(ROLES.configurator)) {
    // Checked here so the HTTP status is honest, and again inside
    // `decideInstall` so the invariant holds for every caller of the decision,
    // including tests and any future non-HTTP path.
    fail(response, 403, 'forbidden', 'installing requires the `configurator` role')
    return
  }
  // The uid comes from the TOKEN, never from the role document. A role
  // document's `userIds` is a list of everyone it grants — and since roles are
  // joined across documents it is now a union of several such lists — so
  // `userIds[0]` would attribute an install to whoever happens to be first.
  // The ledger's entire value is saying who did it.
  const user = await getUser(req)
  if (!user) {
    fail(response, 401, 'unauthenticated', 'authentication required')
    return
  }
  const uid = user.uid
  const principal = { uid, roles: userRoles.roles as readonly string[] }

  try {
    switch (req.method) {
      case 'GET': {
        const snapshot = await db().collection(GRANTS).get()
        response.json({
          installed: snapshot.docs.map((d) => {
            const g = d.data() as Grant
            return {
              name: g.name,
              version: g.activeVersion,
              status: g.status,
              capabilities: g.capabilities ?? [],
            }
          }),
        })
        return
      }

      case 'POST': {
        const manifest = req.body?.manifest as unknown
        const approving = req.body?.approving as
          | Record<string, CapabilityDeclaration>
          | undefined
        if (!manifest) {
          fail(response, 400, 'bad-request', 'expected { manifest } in the body')
          return
        }
        const result = await runInstall({ manifest, approving, principal })
        if (result.error) {
          fail(response, result.httpStatus, result.error as never, result.message ?? '', result.extra ?? {})
          return
        }
        response.status(result.httpStatus).json(result.body)
        return
      }

      case 'DELETE': {
        const name = String(req.query.name ?? '')
        if (!name) {
          fail(response, 400, 'bad-request', 'expected ?name=<namespace>')
          return
        }
        const existing = await readGrant(name)
        if (!existing) {
          fail(response, 404, 'not-found', `nothing installed as "${name}"`)
          return
        }

        const decision = decideRevoke(
          existing,
          principal,
          new Date().toJSON(),
          db().collection(LOG).doc().id
        )
        if (decision.status === 'refused') {
          fail(response, 403, 'refused', 'the revoke was refused', {
            problems: decision.problems,
          })
          return
        }

        await commit(decision.records)
        functions.logger.info(`install: revoked ${name} by ${uid}`)
        // Says what it did NOT do, because "uninstall" reads as "delete my
        // data" and this deliberately is not that.
        response.json({
          status: 'revoked',
          name,
          note: `collections are no longer reachable; no documents were deleted`,
        })
        return
      }

      default:
        fail(response, 400, 'bad-request', 'bad request type')
    }
  } catch (e) {
    if (e instanceof ManifestConflict) {
      functions.logger.warn(`install: ${e.message}`)
      fail(response, 409, 'conflict', e.message)
      return
    }
    functions.logger.error(`install: ${req.method} failed`, e)
    fail(response, 500, 'internal', 'install failed')
  }
})
