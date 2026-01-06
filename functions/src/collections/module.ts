import { COLLECTIONS } from './index'
import { ALL } from './access'
import { ROLES } from './roles'
import { ModuleSchema } from '../../shared/module'

COLLECTIONS.module = {
  schema: ModuleSchema,
  unique: ['name'],
  async validate(data, userRoles, existing): Promise<Error | any> {
    // Track revision count when source changes
    if (existing && existing.source !== data.source) {
      data.revisions = existing.revisions + 1
    } else if (!existing) {
      data.revisions = 0
    }

    return data
  },
  access: {
    [ROLES.public]: {
      read: async (module) => {
        return module.tags.includes('public') ? module : new Error('not public')
      },
      list: async (module) => {
        return module.tags.includes('public') && module.tags.includes('visible')
          ? module
          : new Error('not public and visible')
      },
    },
    [ROLES.developer]: {
      read: ALL,
      write: ALL,
      list: ALL,
    },
  },
}
