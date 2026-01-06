import { ROLES } from './roles'
import { CollectionMap, ALL } from './access'

export const COLLECTIONS: CollectionMap = {
  test: {
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
  },
}
