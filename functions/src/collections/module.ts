import { COLLECTIONS } from './index'
import { ALL } from './access'
import { ROLES } from './roles'
import { ModuleSchema } from '../../shared/module'

COLLECTIONS.module = {
  schema: ModuleSchema,
  unique: ['name'],
  async validate(data, userRoles, existing): Promise<Error | any> {
    // Track revision count when source changes.
    // NOTE: the /doc handler passes `existing = {}` (not undefined) on create,
    // so detect "create" by emptiness, and guard the increment against a
    // missing prior count so older records don't produce NaN.
    const isUpdate = existing && Object.keys(existing).length > 0
    if (!isUpdate) {
      data.revisions = 0
    } else if (existing.source !== data.source) {
      data.revisions = (existing.revisions ?? 0) + 1
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
