import { ROLES } from './roles'
import { CollectionMap, ALL } from './access'

export const COLLECTIONS: CollectionMap = {}

/**
 * Demo collection for the access-control examples and the integration tests.
 *
 * EMULATOR ONLY. It grants the `public` role `write: ALL` and `list: ALL`, and
 * `accessMap` maps POST/PUT/PATCH/**DELETE** to `write` — so in production this
 * was an unauthenticated, schema-less, arbitrary read/write/delete document store
 * sitting in the same database as `role`, `config` and `post`. A 2026-09-06
 * review confirmed it live: `GET /docs?p=test` returned 200 with junk documents
 * dating back to 2024.
 *
 * `FUNCTIONS_EMULATOR` is set to 'true' by the Firebase functions emulator and is
 * absent in deployed functions, so registering behind it keeps the fixture for
 * local work and the integration suite while it cannot ship.
 */
if (process.env.FUNCTIONS_EMULATOR === 'true') {
  COLLECTIONS.test = {
    validate: async (data: any) => {
      if (data.isInvalid) {
        return new Error('invalid data')
      }
      data.sekrit = Math.random()
      return data
    },
    unique: ['unique'],
    access: {
      [ROLES.public]: {
        read: async (data: any) => {
          delete data.sekrit
          data.dynamic = 'this was added dynamically at ' + new Date().toJSON()
          return data
        },
        list: ALL,
        write: ALL,
      },
    },
  }
}
