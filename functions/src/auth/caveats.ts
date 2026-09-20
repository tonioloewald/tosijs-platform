/**
 * Do a token's caveats permit this request? (B2, #6)
 *
 * Separated from `token.ts` because `collections/access.ts` — the portable
 * decision kernel — needs it, and must not pull in the rest of the token
 * machinery to get it.
 *
 * Method and collection caveats are checked here rather than folded into the
 * role set, because they restrict along axes roles do not have. A token scoped
 * to `virta:task` holding `author` is not some narrower role; it is `author`,
 * somewhere specific.
 */

import type { TokenContext } from '../collections/roles.js'

export function caveatsAllow(
  token: TokenContext,
  method: string,
  collectionPath: string
): boolean {
  if (!token.methods.includes(method)) return false
  if (!token.collections) return true
  // Sub-collections are covered by their parent's grant: a token scoped to
  // `virta:task` may reach `virta:task/comment`. Matched on the segment
  // boundary — the trailing `/` is what stops `virta:task` also matching
  // `virta:taskish`, which is a different collection entirely.
  return token.collections.some(
    (allowed) =>
      collectionPath === allowed || collectionPath.startsWith(`${allowed}/`)
  )
}
