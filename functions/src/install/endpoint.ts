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
import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import { unenforcedKeywords } from 'tosijs-schema'

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
  type Manifest,
  type CapabilityDeclaration,
} from './manifest'
import { bumpEpochIn } from './epoch'
import { sameManifest, ManifestConflict } from './manifest-identity'
import { fail } from '../errors'

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

export const install = onRequest({}, async (request, response: Response) => {
  const req = request as AuthenticatedRequest
  if (optionsResponse(req, response, ['OPTIONS', 'GET', 'POST', 'DELETE'])) {
    return
  }

  const userRoles = await getUserRoles(req)
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

        // Read the grant BEFORE trusting the manifest's own name for anything
        // else — `decideInstall` refuses a grant/manifest namespace mismatch.
        const name = (manifest as Manifest).name
        if (typeof name !== 'string') {
          fail(response, 400, 'refused', 'manifest has no name', {
            problems: ['manifest has no name'],
          })
          return
        }
        const existing = await readGrant(name)
        const previousManifest = await readManifest(
          name,
          existing?.activeVersion ?? null
        )

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
          fail(response, 400, 'refused', 'the manifest was refused', {
            problems: decision.problems,
          })
          return
        }

        await commit(decision.records)

        if (decision.status === 'needs-approval') {
          functions.logger.info(
            `install: ${name} parked pending approval of ` +
              `${decision.added.length} capability request(s)`
          )
          // 202: recorded, deliberately not applied. The grant still names the
          // OLD version with the OLD capabilities.
          response.status(202).json({
            status: 'needs-approval',
            name,
            added: decision.added,
            // Says plainly which of these this host cannot yet enforce. An
            // approval prompt that overstates what it is asking about is how
            // people learn to stop reading them.
            unenforced: unenforcedCapabilities(manifest as Manifest),
            note:
              'nothing changed. re-POST with `approving` set to exactly these ' +
              'capabilities to apply the upgrade.',
          })
          return
        }

        functions.logger.info(
          `install: ${decision.status} ${name}@${(manifest as Manifest).version} by ${uid}`
        )
        response.json({
          status: decision.status,
          name,
          version: (manifest as Manifest).version,
          unenforced: unenforcedCapabilities(manifest as Manifest),
        })
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
