import { COLLECTIONS } from './index'
import { ALL } from './access'
import { ROLES } from './roles'
import { RoleSchema } from '../../shared/role'

COLLECTIONS.role = {
  schema: RoleSchema,
  unique: ['name'],
  access: {
    // Only admins can read, write, and list roles
    [ROLES.admin]: {
      read: ALL,
      write: ALL,
      list: ALL,
    },
  },
}
