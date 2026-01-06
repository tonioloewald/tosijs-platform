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

// Collections
import './collections/module'
import './collections/config'
import './collections/role'
import './blog'
import './page'

export { doc } from './doc'
export { docs } from './docs'
// gen is exported separately - see bottom of file
export { hello } from './hello'
export { prefetch, prefetchData } from './prefetch'
export { sitemap } from './sitemap'
export { state } from './state'
export { user } from './user'
export { esm } from './esm'
export { cachedQuery } from './cached-query'
export { stored } from './stored'

export { gen } from './gen'
