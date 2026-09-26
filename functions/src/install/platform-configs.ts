/**
 * The platform's own collection configs, stored as DATA (D14, D19).
 *
 * `post`, `page`, `role`, `config` and the rest used to be compiled TypeScript
 * in `COLLECTIONS`. With `PLATFORM_CONFIGS_FROM_REGISTRY=true` they are read
 * from `system:registry/<name>` instead, through the same registry — the same
 * cache, the same epoch, the same compile — as every installed library.
 *
 * ## Why `system:registry`
 *
 * `system` is a reserved namespace: no manifest may declare it and `/doc`
 * cannot reach it. So these documents are editable ONLY by someone with direct
 * datastore access — the owner acting outside the system, which is exactly the
 * authority D14/D16 say should rewrite the rules everyone else runs under. A
 * broken config is fixed the same way.
 *
 * ## Failure
 *
 * A config that is missing, malformed or fails to compile is simply absent,
 * and deny-by-default makes that collection inaccessible (owner's decision,
 * 2026-09-26). There is no compiled fallback: a fallback would quietly
 * reintroduce the compiled authority this replaces. Role RESOLUTION does not go
 * through the registry (`getUserRoles` reads role documents directly), so a
 * broken `role` config never touches anyone's authority — only editing role
 * documents through `/doc` goes dark until it is fixed.
 */
import type { StoredCollectionConfig } from '../collections/registry'
import { NAMESPACE_SEPARATOR } from '../collections/namespace'
import { EPOCH_PATH } from './epoch'
import { PLATFORM_CONFIGS } from '../collections/seed-configs'

/** Where the platform's configs live. Shared with the epoch document. */
export const PLATFORM_REGISTRY_COLLECTION = EPOCH_PATH.collection

/** The switch. Read per call, so tests can flip it. */
export const platformFromRegistry = (): boolean =>
  process.env.PLATFORM_CONFIGS_FROM_REGISTRY === 'true'

/**
 * A document id for a config name. Firestore ids cannot contain `/`, and
 * `post/comment` is a sub-collection config, so `/` becomes `~`.
 */
export const platformDocId = (name: string): string => name.replace(/\//g, '~')

/**
 * Turn stored documents into configs. PURE — the decisions are here.
 *
 * Refuses, per document, rather than failing the set:
 *   - the epoch document (it shares the collection);
 *   - anything NAMESPACED — this source is for the platform's bare names only;
 *     a library's collections come from its install, never from here;
 *   - a document whose id is not the id of its `name`, so two documents can
 *     never both claim `post` and leave which one wins to query order.
 */
export function platformConfigsFrom(
  docs: Array<{ id: string; data: Record<string, unknown> | undefined }>,
  onError: (message: string) => void = () => undefined
): StoredCollectionConfig[] {
  const out: StoredCollectionConfig[] = []
  for (const { id, data } of docs) {
    if (id === EPOCH_PATH.doc) continue
    const name = data?.name
    if (typeof name !== 'string' || !name) {
      onError(`platform registry: "${id}" has no name — ignored`)
      continue
    }
    if (name.includes(NAMESPACE_SEPARATOR)) {
      onError(`platform registry: "${name}" is namespaced — platform configs are bare names only`)
      continue
    }
    if (platformDocId(name) !== id) {
      onError(`platform registry: document "${id}" claims "${name}" — ids must match names`)
      continue
    }
    if (!data?.collection || typeof data.collection !== 'object') {
      onError(`platform registry: "${name}" has no collection definition`)
      continue
    }
    out.push({
      name,
      namespace: null,
      collection: data.collection as StoredCollectionConfig['collection'],
      ...(typeof data.version === 'string' ? { version: data.version } : {}),
    })
  }
  return out
}

/** Platform names the code expects that the loaded set lacks. Pure. */
export function missingPlatformConfigs(loaded: StoredCollectionConfig[]): string[] {
  const have = new Set(loaded.map((c) => c.name))
  return PLATFORM_CONFIGS.map((c) => c.name).filter((n) => !have.has(n))
}

/**
 * Loaded platform names the code does NOT know. Served — a collection defined
 * by the owner directly in the datastore is legitimate (D14) — but never
 * silently: a stale seed left `post~comment` (public read, schemaless admin
 * write) in a registry once, and it would have been served the moment the
 * switch flipped (0.2.0-beta.5 re-review). Pure.
 */
export function extraPlatformConfigs(loaded: StoredCollectionConfig[]): string[] {
  const known = new Set(PLATFORM_CONFIGS.map((c) => c.name))
  return loaded.map((c) => c.name).filter((n) => !known.has(n))
}
