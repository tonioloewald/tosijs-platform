import type { AuthenticatedRequest } from './utilities'

/**
 * A view of a request with its credentials removed, so anything rendered from it
 * resolves to the anonymous principal.
 *
 * **SSR is public.** Its purpose is SEO, not speed — the site is fast, lean and
 * cache-friendly without it, and authenticated users get the hydrated SPA. So
 * server-rendered output is by definition the public view, and rendering it with
 * the *caller's* rights is never wanted: the output is SHARED and cached, so a
 * privileged visitor triggering a rebuild would bake their private view into a
 * page everyone else reads.
 *
 * `Object.create` keeps the original request as the prototype, so express methods
 * and every other property still work; only `headers` is shadowed. `getUser`
 * returns false without an `authorization` header, which yields `anonymousUser`.
 */
export function asPublicRequest(req: AuthenticatedRequest): AuthenticatedRequest {
  const headers = { ...req.headers }
  delete headers.authorization
  return Object.create(req, {
    headers: { value: headers, enumerable: true, writable: true },
  }) as AuthenticatedRequest
}
