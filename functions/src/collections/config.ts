import { COLLECTIONS } from './index'
import { ALL } from './access'
import { ROLES } from './roles'

COLLECTIONS.config = {
  cacheLatencySeconds: 300, // Cache config docs for 5 minutes
  access: {
    [ROLES.public]: {
      read: ALL,
      list: ALL,
    },
    [ROLES.admin]: {
      read: ALL,
      write: ALL,
      list: ALL,
    },
  },
}
