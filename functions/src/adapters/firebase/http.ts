/**
 * The HTTP port (`http.ts`) on Cloud Functions: a handler becomes a v2
 * `onRequest` function, always deployed publicly invocable. Our own RBAC
 * decides what a caller may DO (endpoint-options.ts says why this is set in
 * code, on every deploy).
 */
import { onRequest } from 'firebase-functions/v2/https'
import { PUBLIC_ENDPOINT } from '../../endpoint-options'
import type { Handler } from '../../http'

export const firebaseEndpoint = (handler: Handler) => onRequest(PUBLIC_ENDPOINT, handler)
