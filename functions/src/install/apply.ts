/**
 * Deciding an install (A3, tosijs-platform#5) — pure logic.
 *
 * Installing is the most privileged write in the system: a manifest becomes
 * collection config, schemas and access rules on somebody's host. So the
 * decision is separated from the writing, and everything consequential happens
 * HERE, where it can be tested without a store, a clock or a network.
 *
 * The handler's job is reduced to: authenticate, call this, write what it says.
 *
 * ## Upgrades are the dangerous case, not installs
 *
 * A first install is a human approving a manifest they read. An UPGRADE is a
 * human approving something they approved once already, months ago, whose
 * contents have since changed — and that is where a library quietly acquires a
 * collection or widens an access rule. So:
 *
 *   - upgrades must be ADDITIVE-ONLY over the previous version. Removing a
 *     collection, removing or newly-requiring a field, or narrowing a type is a
 *     MIGRATION, and v1 refuses rather than guessing.
 *   - any NEW or WIDENED capability re-triggers human approval. An upgrade that
 *     asks for nothing new activates; one that does waits.
 *
 * The capability diff is the thing a human is actually being asked to approve,
 * and it can only be computed because `manifest` records are append-only — a
 * version that overwrote its predecessor would leave nothing to diff against.
 *
 * ## Uninstall never drops rows
 *
 * Revoking sets `status` and keeps the grant. The collections disappear from the
 * registry, so `/doc` denies them by deny-default, but the DATA stays. Removing
 * a library must not be a way to destroy what it held, and a tombstoned grant
 * means a re-install restores the same library to the same collections.
 */

import {
  validateManifest,
  type Manifest,
  type CapabilityDeclaration,
  type ValidateManifestOptions,
} from './manifest'
import { canonical } from './manifest-identity'

export interface Grant {
  /** Namespace this grant governs. */
  name: string
  activeVersion: string | null
  status: 'active' | 'pending' | 'revoked'
  capabilities: Record<string, CapabilityDeclaration>
  approvedBy?: string
  approvedAt?: string
  revokedAt?: string
}

export interface InstallRecords {
  /**
   * `manifest/<name>@<version>` — append-only, never edited.
   *
   * NULL when there is no new manifest to record (a revoke). Deliberately null
   * rather than an empty object: a handler that wrote `{}` to the manifest id
   * would ERASE the stored manifest, and the additive-only check on the next
   * upgrade would then have nothing to diff against and wave it through.
   */
  manifest: { id: string; data: Record<string, unknown> } | null
  /** `grant/<name>` — the only record an install rewrites. */
  grant: { id: string; data: Grant }
  /** `install-log/<id>` — append-only ledger. */
  log: { id: string; data: Record<string, unknown> }
}

export type InstallDecision =
  | { status: 'installed'; records: InstallRecords }
  | { status: 'upgraded'; records: InstallRecords }
  | { status: 'revoked'; records: InstallRecords }
  | {
      status: 'needs-approval'
      /**
       * Still outstanding: new or wider than what was already granted, and not
       * covered by `approving`. This is the list to put in front of a human.
       */
      added: CapabilityEntry[]
      records: InstallRecords
    }
  | { status: 'refused'; problems: string[] }

export interface InstallInput {
  manifest: unknown
  /** The grant for this namespace, if the library is already installed. */
  existing: Grant | null
  /** The previous manifest, needed for the additive-only check. */
  previousManifest: Manifest | null
  /** Who is doing this. Must hold `configurator`. */
  principal: { uid: string; roles: readonly string[] } | null
  nowIso: string
  /** Injected id for the ledger entry, so this stays pure. */
  logId: string
  validate: ValidateManifestOptions
  /**
   * Capabilities the human is approving, right now, by listing them.
   *
   * This is how a parked upgrade gets unparked, and it names CAPABILITIES
   * rather than a version on purpose. Approving "version 1.1.0" would approve
   * whatever that manifest says at the moment the approval lands — and the
   * manifest is fetched from the network, so between reading the diff and
   * clicking yes it can say something else. Approving a list means the thing
   * that takes effect is the thing that was read.
   *
   * Matched exactly, by the same whole-request key as the diff, so approving
   * `maxBytes: 1000` does not approve `maxBytes: 999999`.
   */
  approving?: Record<string, CapabilityDeclaration>
}

/**
 * Is `next` additive over `previous`?
 *
 * "Additive" means an existing consumer of the old version keeps working. So a
 * collection may APPEAR, and a schema may gain an optional field — but removing
 * a collection, removing a field, or newly REQUIRING one all break somebody who
 * is already storing documents in the old shape.
 *
 * Deliberately conservative: anything it cannot prove additive is refused, and
 * the fix is a migration rather than a looser check here.
 */
export function additiveProblems(
  previous: Manifest,
  next: Manifest
): string[] {
  const problems: string[] = []
  for (const [name, before] of Object.entries(previous.collections)) {
    const after = next.collections[name]
    if (!after) {
      problems.push(
        `collection "${name}" was removed — that is a migration, not an upgrade`
      )
      continue
    }
    const beforeProps = Object.keys(
      (before.schema?.properties as Record<string, unknown>) ?? {}
    )
    const afterProps = new Set(
      Object.keys((after.schema?.properties as Record<string, unknown>) ?? {})
    )
    for (const prop of beforeProps) {
      if (!afterProps.has(prop)) {
        problems.push(`"${name}.${prop}" was removed from the schema`)
      }
    }
    const beforeRequired = new Set(
      ((before.schema?.required as string[]) ?? []) as string[]
    )
    for (const prop of ((after.schema?.required as string[]) ?? []) as string[]) {
      if (!beforeRequired.has(prop)) {
        // Newly required breaks every stored document that lacks it.
        problems.push(
          `"${name}.${prop}" is newly required — existing documents would become invalid`
        )
      }
    }
    if (
      JSON.stringify(before.unique ?? []) !== JSON.stringify(after.unique ?? [])
    ) {
      problems.push(
        `"${name}" changed its unique constraint — that cannot be applied to stored data`
      )
    }
  }
  return problems
}

/** A capability, with the name it was declared under. */
export interface CapabilityEntry {
  name: string
  capability: CapabilityDeclaration
}

/**
 * Capabilities in `next` that are new, or that CHANGED.
 *
 * Compared on the WHOLE declaration — arguments and access rules included —
 * using a deep, key-order-independent serialisation. Two separate escalations
 * this is the only thing standing in front of:
 *
 *   - a blob capability whose `maxBytes` grew from 1000 to 999999 is a
 *     different request, not the same one;
 *   - a capability whose `access` widened from `admin` to `public` is likewise
 *     a different request, and this is precisely why the access rules live
 *     INSIDE the declaration. Beside it, an upgrade could open a capability to
 *     everyone with no re-approval.
 *
 * Key order is ignored because a manifest arrives as JSON from a file nobody
 * treats as ordered, and spurious re-approval prompts are how people learn to
 * approve without reading. Array order is preserved, because an access LIST is
 * a sequence.
 */
export function addedCapabilities(
  granted: Record<string, CapabilityDeclaration> = {},
  requested: Record<string, CapabilityDeclaration> = {}
): CapabilityEntry[] {
  return Object.entries(requested)
    .filter(([name, capability]) => {
      const already = granted[name]
      return already === undefined || canonical(already) !== canonical(capability)
    })
    .map(([name, capability]) => ({ name, capability }))
}

export function decideInstall(input: InstallInput): InstallDecision {
  const {
    manifest,
    existing,
    previousManifest,
    principal,
    nowIso,
    logId,
    validate,
  } = input

  // Authority first. `configurator` is the install role; nothing else will do,
  // including `owner` — owner's power is the datastore, not an in-system bypass
  // (D3/D14). An owner who wants to install grants themselves configurator.
  if (!principal) {
    return { status: 'refused', problems: ['not authenticated'] }
  }
  if (!principal.roles.includes('configurator')) {
    return {
      status: 'refused',
      problems: ['installing requires the `configurator` role'],
    }
  }

  const problems = validateManifest(manifest, validate).map((e) => e.message)
  if (problems.length) return { status: 'refused', problems }

  const m = manifest as Manifest

  if (existing && existing.name !== m.name) {
    return {
      status: 'refused',
      problems: [
        `grant is for "${existing.name}" but the manifest is "${m.name}"`,
      ],
    }
  }

  const isUpgrade = Boolean(existing && existing.activeVersion)

  if (isUpgrade && previousManifest) {
    const notAdditive = additiveProblems(previousManifest, m)
    if (notAdditive.length) {
      return { status: 'refused', problems: notAdditive }
    }
  }

  const requested = m.capabilities ?? {}
  const added = addedCapabilities(existing?.capabilities ?? {}, requested)
  // Whatever the human did not explicitly approve is still outstanding.
  // Matched by CONTENT, not by name: approving a name would approve whatever
  // that name means when the approval lands.
  const approving = input.approving ?? {}
  const outstanding = added.filter(
    ({ name, capability }) =>
      approving[name] === undefined ||
      canonical(approving[name]) !== canonical(capability)
  )
  // A new install is always an approval event; an upgrade only when it asks for
  // something new. This is the clause that lets routine upgrades be routine.
  const needsApproval = !isUpgrade ? false : outstanding.length > 0

  const grant: Grant = {
    name: m.name,
    activeVersion: needsApproval ? (existing?.activeVersion ?? null) : m.version,
    status: needsApproval ? 'pending' : 'active',
    capabilities: needsApproval ? (existing?.capabilities ?? {}) : requested,
    approvedBy: needsApproval ? existing?.approvedBy : principal.uid,
    approvedAt: needsApproval ? existing?.approvedAt : nowIso,
  }

  const records: InstallRecords = {
    manifest: {
      id: `${m.name}@${m.version}`,
      data: {
        ...(m as unknown as Record<string, unknown>),
        installedBy: principal.uid,
        installedAt: nowIso,
      },
    },
    grant: { id: m.name, data: grant },
    log: {
      id: logId,
      data: {
        at: nowIso,
        by: principal.uid,
        namespace: m.name,
        version: m.version,
        action: needsApproval
          ? 'upgrade-pending-approval'
          : isUpgrade
            ? 'upgrade'
            : 'install',
        // The real diff, not the outstanding remainder — the ledger records
        // what changed, and separately what a human signed off on.
        addedCapabilities: added,
        ...(Object.keys(approving).length
          ? { approvedCapabilities: approving }
          : {}),
      },
    },
  }

  if (needsApproval) {
    return { status: 'needs-approval', added: outstanding, records }
  }
  return { status: isUpgrade ? 'upgraded' : 'installed', records }
}

/**
 * Revoke a grant. Rows are NEVER dropped — see the header.
 *
 * Returns the records to write; the collections vanish from the registry on the
 * next refresh and `/doc` denies them by deny-default.
 */
export function decideRevoke(
  existing: Grant,
  principal: { uid: string; roles: readonly string[] },
  nowIso: string,
  logId: string
): InstallDecision {
  if (!principal.roles.includes('configurator')) {
    return {
      status: 'refused',
      problems: ['revoking requires the `configurator` role'],
    }
  }
  return {
    status: 'revoked',
    records: {
      // Nothing new to record — the manifest history is already append-only,
      // and writing an empty record over it would destroy the diff basis for a
      // future re-install. See InstallRecords.manifest.
      manifest: null,
      grant: {
        id: existing.name,
        data: { ...existing, status: 'revoked', revokedAt: nowIso },
      },
      log: {
        id: logId,
        data: {
          at: nowIso,
          by: principal.uid,
          namespace: existing.name,
          action: 'revoke',
        },
      },
    },
  }
}
