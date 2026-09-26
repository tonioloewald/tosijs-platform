/**
 * Joining role documents into one authority.
 *
 * Lives in `collections/` — the portable decision kernel — rather than in
 * `utilities.ts`, because "who is this principal" is the single most
 * consequential question the system answers and it should be answerable without
 * Firebase, a network, or an emulator.
 *
 * ## Roles are UNIONED
 *
 * The code this replaces fetched two role documents (`limit 2`) and used
 * `roles[0]`. A principal granted `author` in one document and `admin` in
 * another therefore got whichever `_created desc` happened to put first: a
 * nondeterministic answer to the one question that must not have one, and one
 * that changes silently when an unrelated document is edited.
 *
 * Union is also what the access lattice already says (D5): independently
 * granted authority JOINS. Two grants from an owner are two grants, not a
 * contest between them.
 */

import type { UserRoles } from './roles'
import { anonymousUser } from './roles'

/** A role document, as far as this decision is concerned. */
export interface RoleRecord {
  _id?: string
  name?: string
  roles?: string[]
  userIds?: string[]
  contacts?: Array<{ type: string; value: string }>
}

/**
 * How many role documents one principal may accumulate authority through.
 *
 * A BOUND, not a page size: every matching document is joined, so this caps how
 * much authority one principal can collect rather than truncating a list
 * somebody is paging through. Hitting it means a misconfiguration — or an
 * attempt to assemble authority out of many small grants — and is worth seeing.
 */
export const MAX_ROLE_DOCS = 10

export function joinRoleDocs(
  docs: RoleRecord[],
  warn: (message: string) => void = () => undefined
): UserRoles {
  if (!docs.length) return anonymousUser
  if (docs.length > 1) {
    warn(
      `principal matches ${docs.length} role documents ` +
        `(${docs.map((d) => d._id ?? '?').join(', ')}); joining them`
    )
  }
  const roles = new Set<string>()
  const userIds = new Set<string>()
  const contacts: UserRoles['contacts'] = []
  const seenContacts = new Set<string>()
  for (const doc of docs) {
    for (const role of doc.roles ?? []) roles.add(role)
    for (const id of doc.userIds ?? []) userIds.add(id)
    for (const contact of doc.contacts ?? []) {
      // Deduped: the same email listed on two documents is one contact, and a
      // caller counting contacts should not see the join.
      const key = `${contact.type}\u0000${contact.value}`
      if (seenContacts.has(key)) continue
      seenContacts.add(key)
      contacts.push({
        type: contact.type as 'email' | 'phone' | 'address',
        value: contact.value,
      })
    }
  }
  return {
    _id: docs[0]._id,
    name: docs[0].name || 'unknown',
    contacts,
    roles: [...roles] as UserRoles['roles'],
    userIds: [...userIds],
  }
}

/**
 * The email a principal may be looked up by, or nothing.
 *
 * A role document can name a principal by `contacts` email — that is how a
 * role is pre-assigned to somebody who has not signed in yet. So the email in
 * the ID token is AUTHORITY, and it is only authority if Auth has verified it.
 * With email/password sign-in enabled (every provisioned host, #17) and a
 * public API key, anyone can create an account under any address; unverified,
 * it would inherit whatever roles were waiting for the real owner of that
 * address. `=== true`, not truthiness: absent means unverified.
 */
export function lookupEmail(principal: {
  email?: string
  email_verified?: boolean
}): string | undefined {
  return principal.email_verified === true ? principal.email : undefined
}

/**
 * The display name a credential carries — the name provenance records for
 * WHO authenticated (#28). Pure, so every path that stamps or stores it
 * (role resolution, /token mint, /authorize approval) picks the same one.
 */
export function credentialName(credential: {
  name?: unknown
  email?: unknown
}): string | undefined {
  if (typeof credential.name === 'string' && credential.name) return credential.name
  if (typeof credential.email === 'string' && credential.email) return credential.email
  return undefined
}
