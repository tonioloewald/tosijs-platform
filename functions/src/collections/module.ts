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
    } else {
      // CARRY IT FORWARD. `revisions` is endpoint-managed provenance that the
      // caller does not send, and PUT REPLACES the document — so leaving this
      // branch unassigned dropped the field entirely and reset the revision
      // history to nothing. Editing a module's `name` or `tags` (anything but
      // `source`) silently erased how many times it had been revised.
      // Found 2026-09-06 by the shadow-parity integration run, which is the
      // first time a module was written through the endpoint by a test.
      data.revisions = existing.revisions ?? 0
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
