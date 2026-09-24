/**
 * One error shape (#20).
 *
 * Errors came back in two shapes from the same route — bare text for some
 * refusals, JSON for others, and the JSON used `error` for PROSE. So a client
 * had to try `JSON.parse` on every failure, fall back to the text, and then
 * match on wording to tell an idempotent no-op ("already exists") from a stop
 * ("forbidden"). The first consumer did exactly that, with a regex, which
 * would have broken the day somebody improved a sentence.
 *
 *     { "error": "<stable code>", "message": "<prose>", "details"?: [...] }
 *
 * `error` is the code a client switches on and is part of the contract. The
 * prose is for humans and may be reworded freely — that separation is the
 * whole point, and it only works if nothing ever switches on `message`.
 *
 * ## Opaque denials stay opaque
 *
 * `not-found` is returned both for a document that is missing and for one the
 * caller may not see. That is deliberate: a distinct code for "exists but
 * forbidden" would re-create, in the body, exactly the enumeration the 404
 * exists to prevent. Post-authorization refusals are specific, because by then
 * the caller has already proved access and the information is theirs.
 */

import type { Response } from 'express'

/**
 * The closed set. Adding one is a contract change and should be deliberate;
 * reusing a near-miss is worse, because a client's `switch` then silently
 * takes the wrong branch.
 */
export const ERROR_CODES = [
  'bad-request',
  'unauthenticated',
  'forbidden',
  'not-found',
  'exists',
  'missing',
  'schema',
  'validate',
  'unique',
  'unattributed',
  'immutable',
  'refused',
  'conflict',
  'not-sequenced',
  'rate-limited',
  'internal',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorBody {
  error: ErrorCode
  message: string
  [extra: string]: unknown
}

/**
 * Mark a response uncacheable by any shared cache (#27).
 *
 * Behind Firebase Hosting, a function response WITHOUT `Cache-Control` gets
 * `max-age=600` added, and the CDN keys on the URL alone — not on
 * `Authorization`. So one caller's error was served to every other caller of
 * that URL for ten minutes, whatever their credentials, and no request header
 * could opt out. The worst case is a cached 401: a client that treats 401 as
 * "your token was refused" drops a valid token because someone else's was bad.
 *
 * An API answer is about the caller who asked. Nothing here is shareable.
 */
export function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store')
}

/** Send one. Returns nothing — the response is finished. */
export function fail(
  res: Response,
  status: number,
  error: ErrorCode,
  message: string,
  extra: Record<string, unknown> = {}
): void {
  // Every error sent through here, on any endpoint — including the SSR ones
  // that DO want CDN caching for their successes. An error is never someone
  // else's answer. (Some SSR error paths still write raw responses and bypass
  // this — see TODO.md, #27 follow-ups.)
  noStore(res)
  res.status(status).json({ error, message, ...extra })
}

/**
 * The opaque denial, in the shared shape.
 *
 * Carries no detail on purpose: every branch that reaches it must be
 * indistinguishable from every other, or the body becomes the oracle the
 * status code refuses to be.
 */
export function notFound(res: Response, status = 404): void {
  noStore(res)
  res.status(status).json({ error: 'not-found', message: 'not found' })
}
