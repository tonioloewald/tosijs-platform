/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

/*
import {onRequest} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

export const helloWorld = onRequest((request, response) => {
  logger.info("Hello logs!", {structuredData: true});
  response.send("Hello from Firebase!");
});
*/

// `/state` was REMOVED 2026-09-18. It was a second, unaudited write path into
// the same datastore the access model governs: owner-gated, but bypassing
// COLLECTIONS, schema, validate, uniqueness and afterWrite entirely — writing
// arbitrary caller-named collections with merge:true, stamping `_path` into
// stored documents (the one field /doc deliberately strips, so it could forge
// provenance §5 calls unforgeable), and batch-deleting whole collections.
//
// It had to go BEFORE /install ships: every invariant the install system
// asserts would otherwise be bypassable with one POST /state/push.
//
// It granted an owner nothing they could not already do via the console — per
// D3 `owner` IS the datastore holder — while adding an HTTP-reachable,
// token-bearing surface the console is not. Its useful halves live on:
// `pullState` ≈ scripts/backup-firestore.js, seeding ≈ scripts/seed-*.js, both
// of which write with admin credentials directly.

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
import { setLogSink } from './log'
import { firebaseLogger } from './adapters/firebase/logger'

// The kernel logs through the logger port so it carries no vendor dependency.
// Deployed, the sink is Cloud Logging's structured logger.
setLogSink(firebaseLogger)

import { firebaseEndpoint } from './adapters/firebase/http'
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

// Each endpoint is a plain handler (the HTTP port, http.ts), bound to Cloud
// Functions here. The export NAME is the deployed function's name.
export const doc = firebaseEndpoint(handleDoc)
export const docs = firebaseEndpoint(handleDocs)
// gen is exported separately - see bottom of file
export const hello = firebaseEndpoint(handleHello)
export const prefetch = firebaseEndpoint(handlePrefetch)
export const prefetchData = firebaseEndpoint(handlePrefetchData)
export const sitemap = firebaseEndpoint(handleSitemap)
export const user = firebaseEndpoint(handleUser)
export const esm = firebaseEndpoint(handleEsm)
export const cachedQuery = firebaseEndpoint(handleCachedQuery)
export const stored = firebaseEndpoint(handleStored)
export const claim = firebaseEndpoint(handleClaim)
export const install = firebaseEndpoint(handleInstall)
export const token = firebaseEndpoint(handleToken)
export const authorize = firebaseEndpoint(handleAuthorize)
export const blob = firebaseEndpoint(handleBlobEndpoint)

export { gen } from './gen'
