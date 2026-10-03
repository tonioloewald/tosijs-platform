/**
 * Render on store (D23): re-render after writes to the collections pages are
 * made of. Imported LAST from index.ts, after every collection module has
 * registered itself, so it can wrap their existing hooks.
 *
 * One function per collection is shared by the compiled config and
 * PLATFORM_HOOKS (by name, for registry-loaded configs, D19): the registry
 * parity check requires them to be the same function, and a write must take
 * the same side effects whichever way its config was loaded.
 */
import { COLLECTIONS } from '../collections'
import { PLATFORM_HOOKS } from '../collections/hooks'
import type { CollectionConfig } from '../collections/access'
import { invalidateAfterWrite, INVALIDATING_COLLECTIONS } from './store'

type AfterWrite = NonNullable<CollectionConfig['afterWrite']>

// The SAME list decides what may be stored (store.ts): only what is invalidated.
for (const name of INVALIDATING_COLLECTIONS) {
  const previous: AfterWrite | undefined = COLLECTIONS[name]?.afterWrite ?? PLATFORM_HOOKS[name]?.afterWrite
  const invalidate = invalidateAfterWrite(name)
  const hook: AfterWrite = async (data, userRoles, change) => {
    try {
      if (previous) await previous(data, userRoles, change)
    } finally {
      // Always: a failing earlier hook must not skip invalidation.
      await invalidate(data, userRoles, change)
    }
  }
  if (COLLECTIONS[name]) COLLECTIONS[name] = { ...COLLECTIONS[name], afterWrite: hook } as CollectionConfig
  PLATFORM_HOOKS[name] = { afterWrite: hook }
}
