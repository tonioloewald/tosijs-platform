/**
# access controls for /doc endpoint

`/doc` provides fine-grained access controls and centralized validation via
a `CollectionConfig` structure assigned to the `COLLECTIONS` map.

All properties of a config are optional, and the absence of a config means
no records from the collection will be available.

```
import { COLLECTIONS } from './collections'
import { ROLES } from './roles'
import { ALL } from './access'

COLLECTIONS.post = {
  unique: ['title', 'path'],
  validate: async(post, userRoles) => {
    if (!post.content.trim()) {
      return new Error('this post has no content')
    }
    return post
  },
  access: {
    [ROLES.public]: {
      read: async (post) => {
        if (!post.tags.includes('published')) {
          return new Error('this post has not been published yet')
        }

        return post
      },
      list: async (post) => post.tags.includes('published') ? post : undefined
    },
    [ROLES.admin]: {
      read: ALL,
      write: ALL,
    }
  }
}
```

## `validate: async(data: any, userRoles: UserRoles) => Promise<any | Error>`

You can provide a validation function that processes a record before it is
stored in the database (including making changes to it) and also rejects invalid
records (by returning an error).

## `unique: string[]`

This is a list of fields that should have unique (`string` or `number`) values
in any record. This will be checked **after** validation (so a validation function
can create the unique values if so desired).

## `schema: SchemaBuilder`

Optional tosijs-schema definition for automatic validation. When provided,
documents will be validated against the schema before the custom `validate()`
function runs (if any).

```
import { PageSchema } from '../shared/page'

COLLECTIONS.page = {
  schema: PageSchema,
  // ... other config
}
```

Schema validation provides:
- Type checking for all fields
- Constraint enforcement (min, max, pattern, etc.)
- Detailed error messages with paths

## `cacheLatencySeconds: number`

Optional TTL (time-to-live) for caching document reads. When set, documents from
this collection will be cached in memory for the specified number of seconds.

```
COLLECTIONS.config = {
  cacheLatencySeconds: 300, // Cache for 5 minutes
  ...
}
```

Use this for documents that:
- Are read frequently (e.g., config, settings)
- Change infrequently
- Can tolerate some staleness

Note: Cache is per Cloud Function instance and cleared on cold starts.

## `access: { [key: string]: AccessConfig }`

This controls access to records in a collection. The `key` ROLES.public defines
access for anyone.

The `access` map should define roles in order of *increasing privilege* (i.e.
from most-restricted, such as `public` access through to `admin`, `superuser`,
and `owner` etc.)

```
export interface AccessConfig {
  read?: typeof ALL | FieldAccessMap | AccessFilterFunc
  write?: typeof ALL | FieldAccessMap | AccessFilterFunc
  list?: typeof ALL | FieldAccessMap | AccessFilterFunc
}
```

### AccessConfig

This determines `read`, `write`, and `list` access to records in the collection
for a given role.

- `ALL` provides full sccess
- `FieldAccessMap` restricts access to the specified fields.
- `AccessFilterFunc` can do whatever it pleases, including returning an `Error`
  (which masks docs from `list` requests and blocks access to specific docs)

## Sub-Collections

You can specify access configuration for nested collections by using the `/` syntax
for sub-collections.

E.g. this specifies rules for any `comment` subcollection of a specific `post`.

```
COLLECTIONS['post/comment'] = {
  ...
}
```

*/

import { ROLES, UserRoles } from './roles'
import type { Base } from 'tosijs-schema'

export const ALL = Symbol('ALL')

export type REST_METHOD = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'LIST'

export interface FieldAccessMap {
  [key: string]: typeof ALL | any
}

export type AccessFilterFunc = (
  data: any,
  userRoles: UserRoles
) => Promise<Error | any>

export interface AccessConfig {
  read?: typeof ALL | FieldAccessMap | AccessFilterFunc
  write?: typeof ALL | FieldAccessMap | AccessFilterFunc
  list?: typeof ALL | FieldAccessMap | AccessFilterFunc
}

export interface CollectionConfig {
  schema?: Base<any> // tosijs-schema for automatic validation
  unique?: string[]
  tagFields?: string[] // fields that support array-contains queries via tagField=<value> syntax
  validate?: (
    data: any,
    userRoles: UserRoles,
    existing: any
  ) => Promise<Error | any>
  access?: { [key: string]: AccessConfig | undefined }
  cacheLatencySeconds?: number // TTL cache for reads; cached data may be stale up to this many seconds
}

export interface CollectionMap {
  [key: string]: CollectionConfig
}

export const accessMap = {
  GET: 'read',
  POST: 'write',
  PUT: 'write',
  PATCH: 'write',
  DELETE: 'write',
  LIST: 'list',
}

export const collectionPath = (path: string): string => {
  const pathParts = path.split('/')

  return pathParts.filter((_, index) => index % 2 === 0).join('/')
}

export const getMethodAccess = (
  collections: CollectionMap,
  collectionPath: string,
  method: REST_METHOD,
  userRoles: UserRoles,
  filterFields: string[] | false = false
): typeof ALL | AccessFilterFunc | undefined => {
  const config = collections[collectionPath]

  if (!config || !config.access) {
    return undefined
  }

  let roleAccess = config.access[ROLES.public]
  const accessType = accessMap[method] as 'read' | 'write' | 'list' | undefined

  if (accessType === undefined) {
    return undefined
  }

  let access = roleAccess ? roleAccess[accessType] : undefined

  for (const role of Object.keys(config.access)) {
    if (userRoles.roles.includes(role as keyof typeof ROLES)) {
      roleAccess = config.access[role]
      if (roleAccess && roleAccess[accessType]) {
        access = roleAccess[accessType]
      }
    }
  }

  if (filterFields) {
    if (access === ALL) {
      access = filterFields.reduce((map, key) => {
        map[key] = ALL
        return map
      }, {} as FieldAccessMap)
    } else if (typeof access === 'object') {
      for (const key in Object.keys(access)) {
        if (!filterFields.includes(key)) {
          delete access.key
        }
      }
    }
  }

  if (typeof access === 'object') {
    const _access = access as FieldAccessMap
    return async (data: any): Promise<any> => {
      const { _path } = data
      const filtered: { [key: string]: any } = { _path }
      for (const key of Object.keys(_access)) {
        if (_access[key] === ALL) {
          filtered[key] = data[key]
        }
      }
      return filtered
    }
  } else {
    return access
  }
}
