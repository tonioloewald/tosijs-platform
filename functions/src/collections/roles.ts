export const ROLES = {
  owner: 'owner',
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
