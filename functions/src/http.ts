/**
 * The HTTP port (SOVEREIGN-PLAN.md Phase 1).
 *
 * An endpoint is a `Handler`: a plain function of an Express-shaped request
 * and response. Hosting binds it: on Firebase, `adapters/firebase/http.ts`
 * wraps it in `onRequest` (deployed publicly invocable, endpoint-options.ts);
 * a single-box host can mount the same function on Express or a `Bun.serve`
 * bridge. Endpoint files no longer import `firebase-functions`.
 *
 * Express-shaped, not fetch `(Request) => Response`, for now: the handlers set
 * headers, stream and run `compression` middleware on Express's objects, and
 * keeping those objects is what keeps the deployed behaviour byte-for-byte the
 * same. A fetch-style host gets a bridge in its adapter.
 */
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express'

/** As Cloud Functions delivers it: Express's request plus the unparsed body. */
export interface HttpRequest extends ExpressRequest {
  rawBody: Buffer
}

export type HttpResponse = ExpressResponse

export type Handler = (req: HttpRequest, res: HttpResponse) => void | Promise<void>
