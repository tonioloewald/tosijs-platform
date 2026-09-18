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

export interface UserRoles {
  _id?: string
  _collection?: string
  name: string
  contacts: UserContact[]
  roles: RoleName[]
  userIds: string[]
}

export const anonymousUser: UserRoles = Object.freeze({
  name: 'unknown',
  contacts: [],
  roles: [],
  userIds: [],
})
