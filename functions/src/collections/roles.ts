export const ROLES = {
  owner: 'owner',
  /**
   * May INSTALL libraries. Added 2026-09-18 for tosijs-platform#5.
   *
   * On a different axis from the others, which grade authority over DOCUMENTS.
   * `configurator` has no inherent document rights at all — it is authority over
   * what the system *is*: which collections exist, what their schemas say, who
   * may touch them.
   *
   * Deliberately separate from `owner` rather than folded into it. `owner` is
   * the in-system reflection of datastore ownership (D3) and can already do
   * anything; making install a distinct role means a host can delegate "may
   * install libraries" WITHOUT handing over the data, and means an install shows
   * up in the ledger as its own act rather than as generic owner activity.
   *
   * It is minted by the claim ceremony (proof of substrate ownership) or granted
   * by an `owner` through `role` — which is owner-only (D4), so a configurator
   * cannot appoint another configurator.
   */
  configurator: 'configurator',
  developer: 'developer',
  admin: 'admin',
  editor: 'editor',
  author: 'author',
  public: 'public',
} as const

export type RoleName = (typeof ROLES)[keyof typeof ROLES]

// Legacy alias for backwards compatibility
export type Role = keyof typeof ROLES

export interface UserContact {
  type: 'email' | 'phone' | 'address'
  value: string
}

/**
 * The caveats of the token a request arrived on, if it arrived on one.
 *
 * Carried on `UserRoles` so the restriction reaches the ONE place that already
 * decides authorization (`getMethodAccess`). The alternative — checking it in
 * each endpoint — is a list that has to stay complete forever, and the failure
 * mode of forgetting one is a token reaching somewhere it was scoped out of.
 */
export interface TokenContext {
  id: string
  /** Agent context: machine x repo. This is the provenance (#6). */
  label: string
  methods: readonly string[]
  /** Absent means every collection. */
  collections?: string[]
}

export interface UserRoles {
  _id?: string
  _collection?: string
  name: string
  contacts: UserContact[]
  roles: RoleName[]
  userIds: string[]
  /** Present only when the caller authenticated with a capability token. */
  token?: TokenContext
  /**
   * WHO AUTHENTICATED — the credential's own identity, not the role
   * document's.
   *
   * `userIds` lists every uid on the role document(s) that granted authority,
   * so its first entry is whoever happens to be listed first. A principal
   * matched by contact email, or one sharing a document, was stamped as that
   * person (#28, found by tosijs-virta: every board write read as the host's
   * service principal). Provenance uses this when present; `_by.role` still
   * records which document granted the authority, so both facts are kept.
   *
   * Set by the host's role resolution from the verified credential. Optional,
   * so a kernel consumer that does not set it gets the old behaviour.
   */
  principal?: { uid: string; name?: string }
}

export const anonymousUser: UserRoles = Object.freeze({
  name: 'unknown',
  contacts: [],
  roles: [],
  userIds: [],
})

/**
 * The identity a write is attributed to — ONE rule for every path that
 * attributes (provenance, a manifest's `derive: principal`, /token), so none
 * can drift back to the role document's first uid (#28; 0.2.1 review, B1).
 *
 * `uid`: who AUTHENTICATED when the host supplied it, else the matched
 * document's first uid (a kernel consumer that sets no principal).
 *
 * `name` (owner's decision, 2026-09-26, "curated when owned"):
 *   - the principal is the role document's SOLE owner → the document's name,
 *     which an operator curated (the credential's name only if it has none);
 *   - a contact or shared match → the credential's display name, or nothing.
 *     Never the document's name: it names someone else (#28's visible
 *     symptom). A display name is self-asserted, so spoofing is confined to
 *     the case where no curated name exists for this person;
 *   - no principal (a kernel consumer) → the document's name, as before.
 * Never an email address: `_by` is published with public documents.
 */
export function principalIdentity(userRoles: UserRoles | null | undefined): {
  uid?: string
  name?: string
} {
  if (!userRoles) return {}
  const docName =
    userRoles.name && userRoles.name !== 'unknown' ? userRoles.name : undefined
  const principal = userRoles.principal
  if (!principal) {
    const uid = userRoles.userIds?.[0]
    return { ...(uid ? { uid } : {}), ...(docName ? { name: docName } : {}) }
  }
  const soleOwner =
    userRoles.userIds?.length === 1 && userRoles.userIds[0] === principal.uid
  const name = soleOwner ? (docName ?? principal.name) : principal.name
  return { uid: principal.uid, ...(name ? { name } : {}) }
}
