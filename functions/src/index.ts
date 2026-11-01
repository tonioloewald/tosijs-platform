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

// Every collection config and endpoint handler (kernel.ts); this file only
// binds them to Firebase.
import { ENDPOINTS } from './kernel'
import { firebaseAdmin } from './adapters/firebase/app'
import { setLogSink } from './log'
import { firebaseLogger } from './adapters/firebase/logger'
import { setIdentityProvider } from './identity'
import { firebaseIdentity } from './adapters/firebase/identity'
import { setDataStoreProvider } from './datastore'
import { firebaseDataStore } from './adapters/firebase/datastore'
import { setFilesProvider } from './files'
import { firebaseFiles } from './adapters/firebase/cloud-storage'

// The kernel reaches the vendor only through ports. Deployed, the log sink is
// Cloud Logging's structured logger, identities are Firebase Auth's, the
// datastore is Firestore and files are Cloud Storage.
firebaseAdmin() // initialise the default app before any request
setLogSink(firebaseLogger)
setIdentityProvider(firebaseIdentity)
setDataStoreProvider(firebaseDataStore)
setFilesProvider(firebaseFiles)

import { firebaseEndpoint } from './adapters/firebase/http'

// Each endpoint is a plain handler (the HTTP port, http.ts), bound to Cloud
// Functions here. The export NAME is the deployed function's name, and must be
// the endpoint's key in ENDPOINTS (endpoint-options.test.ts checks).
export const doc = firebaseEndpoint(ENDPOINTS.doc)
export const docs = firebaseEndpoint(ENDPOINTS.docs)
export const hello = firebaseEndpoint(ENDPOINTS.hello)
export const prefetch = firebaseEndpoint(ENDPOINTS.prefetch)
export const prefetchData = firebaseEndpoint(ENDPOINTS.prefetchData)
export const sitemap = firebaseEndpoint(ENDPOINTS.sitemap)
export const user = firebaseEndpoint(ENDPOINTS.user)
export const esm = firebaseEndpoint(ENDPOINTS.esm)
export const cachedQuery = firebaseEndpoint(ENDPOINTS.cachedQuery)
export const stored = firebaseEndpoint(ENDPOINTS.stored)
export const claim = firebaseEndpoint(ENDPOINTS.claim)
export const install = firebaseEndpoint(ENDPOINTS.install)
export const token = firebaseEndpoint(ENDPOINTS.token)
export const authorize = firebaseEndpoint(ENDPOINTS.authorize)
export const blob = firebaseEndpoint(ENDPOINTS.blob)
export const gen = firebaseEndpoint(ENDPOINTS.gen)
