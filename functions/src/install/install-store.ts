/**
 * `/install`'s writes, over the store port (SOVEREIGN-PLAN.md Phase 1).
 *
 * `decideInstall` (apply.ts) decides; this commits what it decided. Moved from
 * `endpoint.ts`, which is now the Firebase binding.
 */
import type { Store } from '../collections/store'
import type { InstallRecords } from './apply'
import type { Proposal } from './proposal'
import { sameManifest, ManifestConflict } from './manifest-identity'

/** `system:registry/epoch` — see epoch.ts for why it lives in `system:`. */
export const EPOCH_DOC = 'system:registry/epoch'

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
 *   - on file, DIFFERENT → refused (ManifestConflict, 409)
 *
 * That last case is the one worth having. Without it, a library could be
 * reviewed at 1.2.0, parked pending approval, and then have 1.2.0's collections
 * and access rules swapped before the human clicks approve — so what takes
 * effect is not what was read. `approving` already pins the capabilities; this
 * pins everything else.
 *
 * The manifest check and the writes are ONE transaction, so a concurrent
 * install of the same version cannot slip in between them: the loser re-runs
 * against what the winner wrote, and gets "identical, proceed" or the 409.
 * (Before the port the check was a read outside a batch, and `create` made the
 * loser fail with a 500 instead.)
 *
 * ## The epoch moves with the config
 *
 * The bump is part of the same commit. A bump issued after a successful commit
 * can be lost — the process is killed, the network drops — and the failure is
 * silent and durable: the config changed, the epoch did not, and every other
 * instance keeps enforcing the old rules. Inside the transaction it is a read
 * and a +1, so concurrent installs cannot lose a bump either.
 */
export async function commitInstall(
  store: Pick<Store, 'transaction'>,
  records: InstallRecords,
  nowIso: string
): Promise<void> {
  await store.transaction(async (tx) => {
    const manifestPath = records.manifest ? `manifest/${records.manifest.id}` : null
    const existing = manifestPath ? await tx.get(manifestPath) : null
    const epoch = await tx.get(EPOCH_DOC)

    if (records.manifest && existing?.exists && !sameManifest(existing.data, records.manifest.data)) {
      throw new ManifestConflict(
        `${records.manifest.id} is already on file with different content — ` +
          `a published version may not change. Publish a new version.`
      )
    }
    if (manifestPath && records.manifest && !existing?.exists) {
      tx.set(manifestPath, records.manifest.data)
    }
    tx.set(`grant/${records.grant.id}`, records.grant.data as unknown as Record<string, unknown>)
    tx.set(`install-log/${records.log.id}`, records.log.data)
    // Monotonic by count rather than by clock: two installs in the same
    // millisecond would produce the same timestamp, and an instance that had
    // already seen that value would skip the reload.
    tx.set(EPOCH_DOC, { value: ((epoch.data.value as number) ?? 0) + 1, at: nowIso }, { merge: true })
  })
}

/**
 * Apply `change` to the proposal at `path` if `allow` says so for what is
 * stored NOW, atomically. Returns whether it did. This is what makes approval
 * single-use: two approvals racing on one proposal cannot both see "pending".
 */
export function updateProposalIf(
  store: Pick<Store, 'transaction'>,
  path: string,
  allow: (current: Proposal | null) => boolean,
  change: Partial<Proposal>
): Promise<boolean> {
  return store.transaction(async (tx) => {
    const snapshot = await tx.get(path)
    if (!allow(snapshot.exists ? (snapshot.data as unknown as Proposal) : null)) return false
    // Never creates: a proposal that is not on file is not approved into being.
    if (!snapshot.exists) return false
    tx.set(path, change as Record<string, unknown>, { merge: true })
    return true
  })
}
