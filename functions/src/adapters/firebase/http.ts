/**
 * The HTTP port (`http.ts`) on Cloud Functions: a handler becomes a v2
 * `onRequest` function, always deployed publicly invocable. Our own RBAC
 * decides what a caller may DO (endpoint-options.ts says why this is set in
 * code, on every deploy).
 *
 * `secrets` names the secrets the endpoint reads (secrets.ts); Cloud Functions
 * mounts only the ones a function declares.
 */
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { PUBLIC_ENDPOINT } from '../../endpoint-options'
import type { Handler } from '../../http'

export const firebaseEndpoint = (handler: Handler, options: { secrets?: readonly string[] } = {}) =>
  onRequest(
    { ...PUBLIC_ENDPOINT, ...(options.secrets?.length ? { secrets: options.secrets.map((name) => defineSecret(name)) } : {}) },
    handler
  )
