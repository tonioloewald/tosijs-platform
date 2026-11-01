/**
 * The platform without a host: every collection config, registered, and
 * every endpoint, as a plain handler (the HTTP port, http.ts). A host imports
 * this, installs its ports (log sink, identity, datastore, files) and binds
 * `ENDPOINTS` to its HTTP server: index.ts to Cloud Functions, the Bun server
 * (adapters/bun/server.ts) to a single process.
 *
 * Nothing here names a vendor (vendor-imports.test.ts, endpoint-wiring.test.ts).
 */

// Collections
import './collections/module'
import './collections/config'
import './collections/role'
import './collections/install-records'
import './collections/token-records'
import './blog'
import './page'
// Render on store (D23): re-render after writes to post/page/config. LAST, so it
// wraps the hooks the modules above registered.
import './render/hooks'

import type { Handler } from './http'
import { handleDoc } from './doc'
import { handleDocs } from './docs'
import { handleHello } from './hello'
import { handlePrefetch, handlePrefetchData } from './prefetch'
import { handleSitemap } from './sitemap'
import { handleUser } from './user'
import { handleEsm } from './esm'
import { handleCachedQuery } from './cached-query'
import { handleStored } from './stored'
import { handleClaim } from './claim'
import { handleInstall } from './install/endpoint'
import { handleToken } from './auth/endpoint'
import { handleAuthorize } from './auth/authorize-endpoint'
import { handleBlobEndpoint } from './blob-endpoint'
import { handleGen, GEN_SECRETS } from './gen'

export interface Endpoint {
  handler: Handler
  /** The secrets it reads (secrets.ts); Cloud Functions mounts only these. */
  secrets?: readonly string[]
}

/** Every endpoint by its name: the deployed function's name, and its path on the Bun server. */
export const ENDPOINTS = {
  doc: { handler: handleDoc },
  docs: { handler: handleDocs },
  hello: { handler: handleHello },
  prefetch: { handler: handlePrefetch },
  prefetchData: { handler: handlePrefetchData },
  sitemap: { handler: handleSitemap },
  user: { handler: handleUser },
  esm: { handler: handleEsm },
  cachedQuery: { handler: handleCachedQuery },
  stored: { handler: handleStored },
  claim: { handler: handleClaim },
  install: { handler: handleInstall },
  token: { handler: handleToken },
  authorize: { handler: handleAuthorize },
  blob: { handler: handleBlobEndpoint },
  gen: { handler: handleGen, secrets: GEN_SECRETS },
} satisfies Record<string, Endpoint>
