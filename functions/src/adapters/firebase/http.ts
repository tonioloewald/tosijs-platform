/**
 * The HTTP port (`http.ts`) on Cloud Functions: a handler becomes a v2
 * `onRequest` function, always deployed publicly invocable. Our own RBAC
 * decides what a caller may DO (endpoint-options.ts says why this is set in
 * code, on every deploy).
 *
 * `secrets` names the secrets the endpoint reads (secrets.ts); Cloud Functions
 * mounts only the ones a function declares. `timeoutSeconds` raises the
 * default 60-second request limit for an endpoint that needs longer.
 */
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { PUBLIC_ENDPOINT } from '../../endpoint-options'
import type { Endpoint } from '../../kernel'

export const firebaseEndpoint = ({ handler, secrets, timeoutSeconds }: Endpoint) =>
  onRequest(
    {
      ...PUBLIC_ENDPOINT,
      ...(secrets?.length ? { secrets: secrets.map((name) => defineSecret(name)) } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
    },
    handler
  )
