/**
 * Installing a manifest as the OPERATOR: someone holding the datastore itself
 * (D16's "outside privileges"), not a caller of `/install`.
 *
 * Since D28 the blog's posts and pages are the blog manifest's collections, not
 * the platform's, so a host without that manifest installed has no blog. A
 * fresh test host and an emulator seed need it installed, and there is nobody
 * at a browser to approve it. This makes the same decision `/install` makes
 * (`decideInstall`: validation, the additive-only upgrade check) and approves
 * whatever the manifest asks for, because the operator IS the human: they could
 * write the same records by hand.
 *
 * It is never reachable from a request. Callers are a test host, a seed
 * script and a dev host, each with the store already in hand.
 */
import { randomUUID } from 'crypto'
import { unenforcedKeywords } from 'tosijs-schema'
import { ROLES } from '../collections/roles'
import type { Store } from '../collections/store'
import { decideInstall, type Grant, type InstallDecision } from './apply'
import { commitInstall } from './install-store'
import type { Manifest } from './manifest'

export interface OperatorInstallInput {
  manifest: Manifest
  /** The installed grant for this namespace, if any. */
  existing: Grant | null
  /** The manifest that grant names, for the additive-only check. */
  previousManifest: Manifest | null
  nowIso: string
  logId: string
  /** Recorded as `installedBy` / `approvedBy`. Default `operator`. */
  by?: string
}

/** Pure: the records `/install` would write, approved by the operator. */
export function operatorInstall(input: OperatorInstallInput): InstallDecision {
  const { manifest, existing, previousManifest, nowIso, logId, by = 'operator' } = input
  return decideInstall({
    manifest,
    existing,
    previousManifest,
    principal: { uid: by, roles: [ROLES.configurator] },
    nowIso,
    logId,
    validate: {
      unenforced: (schema) => unenforcedKeywords(schema as never) as string[],
      knownRoles: Object.values(ROLES),
    },
    approving: manifest.capabilities ?? {},
  })
}

/**
 * Install (or upgrade to) `manifest` in `store`, committing as `/install`
 * does: the records and the registry epoch together. Throws with the reasons
 * when the manifest is refused; re-installing the same version is a no-op
 * apart from a new ledger entry.
 */
export async function installAsOperator(
  store: Pick<Store, 'get' | 'transaction'>,
  manifest: Manifest,
  { nowIso = new Date().toISOString(), by }: { nowIso?: string; by?: string } = {}
): Promise<InstallDecision['status']> {
  const grantDoc = await store.get(`grant/${manifest.name}`)
  const existing = grantDoc.exists ? (grantDoc.data as unknown as Grant) : null
  const previous = existing?.activeVersion
    ? await store.get(`manifest/${manifest.name}@${existing.activeVersion}`)
    : null
  const decision = operatorInstall({
    manifest,
    existing,
    previousManifest: previous?.exists ? (previous.data as unknown as Manifest) : null,
    nowIso,
    logId: randomUUID(),
    by,
  })
  if (decision.status === 'refused') {
    throw new Error(`${manifest.name}@${manifest.version} refused: ${decision.problems.join('; ')}`)
  }
  await commitInstall(store, decision.records, nowIso)
  return decision.status
}
