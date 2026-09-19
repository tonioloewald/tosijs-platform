/**
 * Installed collections, read from the datastore (#5, #7).
 *
 * This is what makes `/install` do anything: the grant and manifest records it
 * writes become live collection configs here, compiled through exactly the same
 * `compileCollection` the platform's own seeded configs go through.
 *
 * ## Why platform collections still come from compiled TypeScript
 *
 * `collectionsFor()` consults the registry ONLY for a namespaced path. A bare
 * name — `post`, `role`, `config` — short-circuits straight to `COLLECTIONS`
 * with no read at all.
 *
 * That is deliberate sequencing (D18), not an accident of implementation. The
 * seeded configs in `seed-configs.ts` are proven equivalent to the TypeScript
 * they replace and are ready to swap in, but swapping them puts a live blog's
 * every request behind a datastore read and a compile step, in the same change
 * that first exposes install to a third party. Doing them separately means a
 * failure in either one is attributable. Until then the blog's hot path is
 * byte-for-byte what it was.
 *
 * ## Fail-closed, per library
 *
 * A grant whose manifest document is missing contributes NOTHING rather than
 * some partial config — that library's collections become unavailable and the
 * loss is logged. Every other library is unaffected, per the isolation
 * `compileStored` already provides.
 *
 * ## The namespace rule is re-checked HERE, not just at install
 *
 * `refuseDeclaration` runs again on load. Install-time validation protects
 * against a bad manifest arriving through the endpoint; this protects against
 * one arriving any other way — a direct datastore write, a record installed
 * before the rule tightened, a restored backup. Without it, planting a manifest
 * whose collections map contains the bare key `role` would let an installed
 * library shadow the collection that defines everyone's authority. The map is
 * ALSO merged platform-last so a bare name could not win even if it slipped
 * through; two independent defences, because this one is worth two.
 */

import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'

import {
  CollectionRegistry,
  type ConfigSource,
  type StoredCollectionConfig,
} from '../collections/registry'
import { COLLECTIONS } from '../collections'
import type { CollectionMap } from '../collections/access'
import {
  NAMESPACE_SEPARATOR,
  refuseDeclaration,
} from '../collections/namespace'
import { readEpoch } from './epoch'
import type { Grant } from './apply'
import type { Manifest } from './manifest'

/** One active grant paired with the manifest it names. */
export interface InstalledPair {
  grant: Grant
  /** null when the manifest document is missing. */
  manifest: Manifest | null
}

/**
 * Turn grants + manifests into stored configs. Pure — this is the part with
 * decisions in it, so it is the part that gets tested without Firebase.
 */
export function configsFromInstalled(
  pairs: InstalledPair[],
  onError: (message: string) => void = () => undefined
): StoredCollectionConfig[] {
  const configs: StoredCollectionConfig[] = []
  for (const { grant, manifest } of pairs) {
    if (!grant.activeVersion) continue
    if (!manifest) {
      onError(
        `registry: grant "${grant.name}" names version ${grant.activeVersion} ` +
          `but that manifest is missing — its collections are unavailable`
      )
      continue
    }
    for (const [name, collection] of Object.entries(
      manifest.collections ?? {}
    )) {
      const refused = refuseDeclaration(grant.name, name)
      if (refused) {
        onError(
          `registry: refusing "${name}" from "${grant.name}": ${refused.message}`
        )
        continue
      }
      configs.push({
        name,
        namespace: grant.name,
        collection,
        version: grant.activeVersion,
      })
    }
  }
  return configs
}

export class InstalledConfigSource implements ConfigSource {
  async load(): Promise<StoredCollectionConfig[]> {
    const db = admin.firestore()
    // Everything except a revoked tombstone. A revoked grant's row survives so
    // a re-install restores the same library to the same collections, but it
    // must not contribute config.
    //
    // `pending` MUST be included. A pending grant is a live install whose
    // UPGRADE is parked waiting on a human — it still names `activeVersion`,
    // and that version is still in force. Filtering to `active` alone meant
    // asking for one new capability took the whole library offline until
    // somebody clicked approve, which turns a safety prompt into an outage and
    // would teach every operator to approve without reading.
    const grants = await db
      .collection('grant')
      .where('status', 'in', ['active', 'pending'])
      .get()

    const pairs: InstalledPair[] = await Promise.all(
      grants.docs.map(async (doc) => {
        const grant = doc.data() as Grant
        if (!grant.activeVersion) return { grant, manifest: null }
        const snapshot = await db
          .collection('manifest')
          .doc(`${grant.name}@${grant.activeVersion}`)
          .get()
        return {
          grant,
          manifest: snapshot.exists ? (snapshot.data() as Manifest) : null,
        }
      })
    )
    return configsFromInstalled(pairs, (m) => functions.logger.error(m))
  }

  async epoch(): Promise<number> {
    return readEpoch()
  }
}

export const installedRegistry = new CollectionRegistry(
  new InstalledConfigSource(),
  { onError: (message) => functions.logger.warn(message) }
)

/**
 * Platform collections spread LAST, so they always win — an installed config
 * can never shadow `role`, `post` or `config`, whatever a manifest says.
 */
export const mergePlatformLast = (installed: CollectionMap): CollectionMap => ({
  ...installed,
  ...COLLECTIONS,
})

/**
 * The collection map to use for one request.
 *
 * A bare name returns `COLLECTIONS` ITSELF — the same object, no copy, no read,
 * no await that resolves anywhere. That identity is the property worth pinning:
 * it is what guarantees a live blog's request path is unchanged by any of this.
 */
export async function collectionsFor(
  collectionPath: string
): Promise<CollectionMap> {
  if (!collectionPath.includes(NAMESPACE_SEPARATOR)) return COLLECTIONS
  return mergePlatformLast(await installedRegistry.collections())
}
