/**
 * Test environment for `src/` unit tests.
 *
 * `src/` modules import tosijs/tosijs-ui, which define web components at module
 * scope and therefore require DOM globals at import time — which is why `src/`
 * had no tests at all (review finding F11). happy-dom is tosijs-ui's own
 * declared peer for this, so we use the same thing it tests against.
 *
 * Registered via bunfig.toml `preload`, so `bun test` needs no extra flags.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof globalThis.HTMLElement === 'undefined') {
  GlobalRegistrator.register()
}
