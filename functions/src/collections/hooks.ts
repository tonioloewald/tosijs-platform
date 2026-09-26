/**
 * Side-effect hooks for the platform's own collections, attached BY NAME.
 *
 * Collection configs are data (D14): stored, compiled, and never code — which
 * is what makes them installable, diffable and fixable from outside. But a few
 * platform collections need a side effect that data cannot express: saving a
 * `post` must clear the blog cache, or the site serves the old post for up to
 * a day (the bug `afterWrite` was added to fix).
 *
 * A side effect is not AUTHORITY. It decides nothing about who may do what —
 * it runs only after a write the data config has already allowed and
 * committed. So it may live in code, and this is the one place it does. Once
 * `/doc` reads bare names from the registry (D19), `collectionsFor` attaches
 * these to whatever config was loaded for that name.
 *
 * Deliberately narrow: `afterWrite` only. Anything that could change what a
 * write is allowed to do (`validate`, access) belongs in the stored config,
 * where it can be seen and diffed.
 */
import type { CollectionConfig } from './access'

export type PlatformHooks = Pick<CollectionConfig, 'afterWrite'>

export const PLATFORM_HOOKS: Record<string, PlatformHooks> = {}
