/**
 * Render on store: what a STORED value may depend on. Pure (no Firebase), so
 * it is tested directly; store.ts gives it to the ComputedStore, which
 * enforces it for every compute.
 */

/** Collections whose writes invalidate (render/hooks.ts). A value read from any other cannot be kept. */
export const INVALIDATING_COLLECTIONS = ['post', 'page', 'config']

/**
 * May a STORED value depend on this? Only on what a write invalidates: a
 * top-level document or list of a hooked collection, or another computed
 * value. Anything else (another collection, a sub-collection path) means the
 * value is returned but not kept — enforced by the store for every compute.
 */
export function isInvalidatedDep(dep: string): boolean {
  if (dep.startsWith('computed:')) return true
  const m = dep.match(/^(doc|list):([^/]+)(?:\/(.*))?$/)
  if (!m) return false
  const [, kind, collection, rest] = m
  if (!INVALIDATING_COLLECTIONS.includes(collection)) return false
  return kind === 'list' ? rest === undefined : rest !== undefined && !rest.includes('/')
}

