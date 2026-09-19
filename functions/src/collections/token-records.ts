/**
 * The `token` collection (B2, #6).
 *
 * Registered with NO access entry for anyone — not even owner — so `/doc` and
 * `/docs` refuse every method by deny-default. Tokens are read, listed and
 * revoked exclusively through `/token`, which filters to the caller's own.
 *
 * ## Why not expose it read-only to its owner
 *
 * The declarative visibility vocabulary is row-relative, not CALLER-relative:
 * `{field: 'principalUid', op: 'eq', value: …}` needs a literal, and the
 * literal that would be correct is different for every caller. Granting `read`
 * to any role at all would therefore expose every principal's token records to
 * that role, which is the opposite of what a per-agent credential is for.
 *
 * Registering it at all — rather than leaving it undefined, which denies just
 * as thoroughly — states the intent, gives the blocker tests something to
 * assert against, and reserves the name so no manifest can declare it.
 *
 * The stored record holds a sha256, never the secret, so even a hypothetical
 * read would not yield a usable credential. That is belt and braces, not the
 * reason this is closed.
 */

import { COLLECTIONS } from './index'

COLLECTIONS.token = {
  // No `schema` and no `access`, matching the install records: nothing reaches
  // this collection through /doc, so there is no request for a schema to
  // validate. Shape is enforced by `decideMint` at the one door that writes it.
  unique: ['hash'],
  access: {},
}
