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
import './blog'
import './page'
import * as functions from 'firebase-functions'
import { setAccessLogger } from './collections/access'

// The decision layer logs through an injected sink so it carries no vendor
// dependency (it is the portable kernel). Deployed, that sink is Cloud Logging.
setAccessLogger(functions.logger)

export { doc } from './doc'
export { docs } from './docs'
// gen is exported separately - see bottom of file
export { hello } from './hello'
export { prefetch, prefetchData } from './prefetch'
export { sitemap } from './sitemap'
export { user } from './user'
export { esm } from './esm'
export { cachedQuery } from './cached-query'
export { stored } from './stored'

export { gen } from './gen'
