// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { test, expect, describe } from 'bun:test'
import { ALL, collectionPath, getMethodAccess, CollectionMap } from './access'
import { ROLES, UserRoles, RoleName } from './roles'

// Helper to create mock user roles
const createUserRoles = (roles: string[]): UserRoles => ({
  name: 'Test User',
  contacts: [{ type: 'email', value: 'test@example.com' }],
  roles: roles as RoleName[],
  userIds: ['test-uid'],
})

const publicUser = createUserRoles([ROLES.public])
const authorUser = createUserRoles([ROLES.author])
const adminUser = createUserRoles([ROLES.admin])
const developerUser = createUserRoles([ROLES.developer])
// Reserved for future tests:
// const ownerUser = createUserRoles([ROLES.owner])
// const multiRoleUser = createUserRoles([ROLES.author, ROLES.editor])

describe('collectionPath', () => {
  test('extracts collection path from document path', () => {
    expect(collectionPath('posts/123')).toBe('posts')
    expect(collectionPath('users/abc/comments/xyz')).toBe('users/comments')
    expect(collectionPath('a/1/b/2/c/3')).toBe('a/b/c')
  })

  test('handles single collection', () => {
    expect(collectionPath('posts/doc1')).toBe('posts')
  })
})

describe('getMethodAccess', () => {
  // Test collection configuration
  const testCollections: CollectionMap = {
    // Public read, author write
    posts: {
      access: {
        [ROLES.public]: {
          read: ALL,
          list: ALL,
        },
        [ROLES.author]: {
          write: ALL,
        },
      },
    },
    // Admin only
    secrets: {
      access: {
        [ROLES.admin]: {
          read: ALL,
          write: ALL,
          list: ALL,
        },
      },
    },
    // No access config (should deny all)
    locked: {},
    // Field-filtered access
    profiles: {
      access: {
        [ROLES.public]: {
          read: {
            name: ALL,
            avatar: ALL,
          },
          list: {
            name: ALL,
          },
        },
        [ROLES.admin]: {
          read: ALL,
          write: ALL,
          list: ALL,
        },
      },
    },
    // Custom filter function
    drafts: {
      access: {
        [ROLES.public]: {
          read: async (data: any) => {
            if (!data.published) {
              return new Error('not published')
            }
            return data
          },
        },
        [ROLES.author]: {
          read: ALL,
          write: ALL,
          list: ALL,
        },
      },
    },
  }

  describe('public access', () => {
    test('allows public read when configured', () => {
      const access = getMethodAccess(
        testCollections,
        'posts',
        'GET',
        publicUser
      )
      expect(access).toBe(ALL)
    })

    test('allows public list when configured', () => {
      const access = getMethodAccess(
        testCollections,
        'posts',
        'LIST',
        publicUser
      )
      expect(access).toBe(ALL)
    })

    test('denies public write when not configured', () => {
      const access = getMethodAccess(
        testCollections,
        'posts',
        'POST',
        publicUser
      )
      expect(access).toBeUndefined()
    })

    test('denies all access to admin-only collection', () => {
      expect(
        getMethodAccess(testCollections, 'secrets', 'GET', publicUser)
      ).toBeUndefined()
      expect(
        getMethodAccess(testCollections, 'secrets', 'POST', publicUser)
      ).toBeUndefined()
      expect(
        getMethodAccess(testCollections, 'secrets', 'LIST', publicUser)
      ).toBeUndefined()
    })
  })

  describe('role-based access', () => {
    test('author can write to posts', () => {
      const access = getMethodAccess(
        testCollections,
        'posts',
        'POST',
        authorUser
      )
      expect(access).toBe(ALL)
    })

    test('admin can access secrets', () => {
      expect(
        getMethodAccess(testCollections, 'secrets', 'GET', adminUser)
      ).toBe(ALL)
      expect(
        getMethodAccess(testCollections, 'secrets', 'POST', adminUser)
      ).toBe(ALL)
      expect(
        getMethodAccess(testCollections, 'secrets', 'LIST', adminUser)
      ).toBe(ALL)
    })

    test('developer cannot access admin-only secrets', () => {
      expect(
        getMethodAccess(testCollections, 'secrets', 'GET', developerUser)
      ).toBeUndefined()
    })

    test('role inheritance - higher roles get lower role access', () => {
      // Author can read posts (public access)
      expect(getMethodAccess(testCollections, 'posts', 'GET', authorUser)).toBe(
        ALL
      )
    })
  })

  describe('missing/invalid configurations', () => {
    test('returns undefined for non-existent collection', () => {
      expect(
        getMethodAccess(testCollections, 'nonexistent', 'GET', publicUser)
      ).toBeUndefined()
    })

    test('returns undefined for collection without access config', () => {
      expect(
        getMethodAccess(testCollections, 'locked', 'GET', publicUser)
      ).toBeUndefined()
      expect(
        getMethodAccess(testCollections, 'locked', 'GET', adminUser)
      ).toBeUndefined()
    })
  })

  describe('field-filtered access', () => {
    test('returns filter function for field-based access', async () => {
      const access = getMethodAccess(
        testCollections,
        'profiles',
        'GET',
        publicUser
      )
      expect(typeof access).toBe('function')

      if (typeof access === 'function') {
        const filtered = await access(
          {
            _path: 'profiles/123',
            name: 'John',
            avatar: 'avatar.png',
            email: 'secret@example.com',
            password: 'hash',
          },
          publicUser
        )
        expect(filtered).toEqual({
          _path: 'profiles/123',
          name: 'John',
          avatar: 'avatar.png',
        })
        expect(filtered.email).toBeUndefined()
        expect(filtered.password).toBeUndefined()
      }
    })

    test('admin gets ALL access to profiles', () => {
      const access = getMethodAccess(
        testCollections,
        'profiles',
        'GET',
        adminUser
      )
      expect(access).toBe(ALL)
    })
  })

  describe('custom filter functions', () => {
    test('custom filter can deny access', async () => {
      const access = getMethodAccess(
        testCollections,
        'drafts',
        'GET',
        publicUser
      )
      expect(typeof access).toBe('function')

      if (typeof access === 'function') {
        const result = await access({ published: false }, publicUser)
        expect(result).toBeInstanceOf(Error)
      }
    })

    test('custom filter can allow access', async () => {
      const access = getMethodAccess(
        testCollections,
        'drafts',
        'GET',
        publicUser
      )

      if (typeof access === 'function') {
        const result = await access(
          { published: true, content: 'Hello' },
          publicUser
        )
        expect(result).toEqual({ published: true, content: 'Hello' })
      }
    })

    test('author bypasses custom filter with ALL access', () => {
      const access = getMethodAccess(
        testCollections,
        'drafts',
        'GET',
        authorUser
      )
      expect(access).toBe(ALL)
    })
  })

  describe('HTTP method mapping', () => {
    test('GET maps to read', () => {
      expect(getMethodAccess(testCollections, 'posts', 'GET', publicUser)).toBe(
        ALL
      )
    })

    test('POST maps to write', () => {
      expect(
        getMethodAccess(testCollections, 'posts', 'POST', authorUser)
      ).toBe(ALL)
    })

    test('PUT maps to write', () => {
      expect(getMethodAccess(testCollections, 'posts', 'PUT', authorUser)).toBe(
        ALL
      )
    })

    test('PATCH maps to write', () => {
      expect(
        getMethodAccess(testCollections, 'posts', 'PATCH', authorUser)
      ).toBe(ALL)
    })

    test('DELETE maps to write', () => {
      expect(
        getMethodAccess(testCollections, 'posts', 'DELETE', authorUser)
      ).toBe(ALL)
    })

    test('LIST maps to list', () => {
      expect(
        getMethodAccess(testCollections, 'posts', 'LIST', publicUser)
      ).toBe(ALL)
    })
  })
})

describe('ROLES constants', () => {
  test('has expected role values', () => {
    expect(ROLES.public).toBe('public')
    expect(ROLES.author).toBe('author')
    expect(ROLES.editor).toBe('editor')
    expect(ROLES.admin).toBe('admin')
    expect(ROLES.developer).toBe('developer')
    expect(ROLES.owner).toBe('owner')
  })
})

// ---------------------------------------------------------------------------
// Characterization of dispatch dimensions the TODO flags as untested:
// multi-role precedence, sub-collection paths, write-side field maps, and the
// (known-broken) filterFields argument. Oracle for the tjs-lang port.
// ---------------------------------------------------------------------------

describe('getMethodAccess — multi-role precedence', () => {
  const collections: CollectionMap = {
    // Roles listed in increasing privilege, per the access.ts contract.
    articles: {
      access: {
        [ROLES.public]: { read: ALL, list: ALL },
        [ROLES.author]: { write: { title: ALL, body: ALL } },
        [ROLES.editor]: { write: ALL },
      },
    },
    // `admin` defines write but omits read; `public` defines read.
    mixed: {
      access: {
        [ROLES.public]: { read: ALL },
        [ROLES.admin]: { write: ALL },
      },
    },
  }

  test('last matching role in config order wins (editor ALL overrides author field-map)', () => {
    const user = createUserRoles([ROLES.author, ROLES.editor])
    expect(getMethodAccess(collections, 'articles', 'POST', user)).toBe(ALL)
  })

  test('result is independent of the order of the user roles array', () => {
    const a = createUserRoles([ROLES.author, ROLES.editor])
    const b = createUserRoles([ROLES.editor, ROLES.author])
    expect(getMethodAccess(collections, 'articles', 'POST', a)).toBe(
      getMethodAccess(collections, 'articles', 'POST', b)
    )
  })

  // CHANGED 2026-09-06 (review F1). This used to assert that an author-only
  // write field map yields a strainer function. That was true of the HELPER and
  // false of the SYSTEM: `doc.ts`'s write branch only tests the result for
  // truthiness, so the strainer was built and then ignored — the config read as a
  // restriction and behaved as unrestricted write. This test passing is precisely
  // why the gap "looked covered". Non-ALL write configs now fail closed.
  test('author-only write DENIES, because the write path cannot enforce a field map', () => {
    const user = createUserRoles([ROLES.author])
    expect(getMethodAccess(collections, 'articles', 'POST', user)).toBeUndefined()
  })

  test('a matching role that omits the access type does not clear inherited public access', () => {
    // admin block has no `read`; the public read=ALL must still apply to an admin.
    const user = createUserRoles([ROLES.admin])
    expect(getMethodAccess(collections, 'mixed', 'GET', user)).toBe(ALL)
  })

  test('public access type applies even to a user with no matching role block', () => {
    const user = createUserRoles([ROLES.author]) // author is not listed in `mixed`
    expect(getMethodAccess(collections, 'mixed', 'GET', user)).toBe(ALL)
    // ...but there is no write for author in `mixed`, so writes are denied.
    expect(getMethodAccess(collections, 'mixed', 'POST', user)).toBeUndefined()
  })
})

describe('getMethodAccess — sub-collections', () => {
  const collections: CollectionMap = {
    post: { access: { [ROLES.public]: { read: ALL } } },
    'post/comment': {
      access: {
        [ROLES.public]: { read: ALL, list: ALL },
        [ROLES.author]: { write: ALL },
      },
    },
  }

  test('collectionPath collapses doc ids to the sub-collection key', () => {
    expect(collectionPath('post/123/comment/456')).toBe('post/comment')
  })

  test('resolves access for a configured sub-collection', () => {
    expect(
      getMethodAccess(collections, 'post/comment', 'GET', publicUser)
    ).toBe(ALL)
    expect(
      getMethodAccess(collections, 'post/comment', 'POST', authorUser)
    ).toBe(ALL)
  })

  test('unconfigured sub-collection denies by default even if the parent is readable', () => {
    expect(
      getMethodAccess(collections, 'post/like', 'GET', publicUser)
    ).toBeUndefined()
  })
})

describe('getMethodAccess — write-side field maps', () => {
  const collections: CollectionMap = {
    posts: {
      access: {
        [ROLES.author]: { write: { title: ALL, body: ALL } },
        [ROLES.admin]: { write: ALL },
      },
    },
  }

  // CHANGED 2026-09-06 (review F1) — see the note above. A write field map is
  // now DENIED rather than strained, because straining a write would silently
  // drop fields the author submitted, and the write path never applied it anyway.
  test('a write FieldAccessMap denies rather than silently granting write-everything', () => {
    expect(getMethodAccess(collections, 'posts', 'PATCH', authorUser)).toBeUndefined()
  })

  test('admin write ALL bypasses the field map', () => {
    expect(getMethodAccess(collections, 'posts', 'PATCH', adminUser)).toBe(ALL)
  })
})

describe('getMethodAccess — filterFields argument (see TODO.md: known bug)', () => {
  const collections: CollectionMap = {
    profiles: {
      access: {
        [ROLES.public]: { read: { name: ALL, email: ALL } },
        [ROLES.admin]: { read: ALL },
      },
    },
  }

  test('ALL access narrowed to requested fields (this branch works)', async () => {
    const access = getMethodAccess(collections, 'profiles', 'GET', adminUser, [
      'name',
    ])
    expect(typeof access).toBe('function')
    if (typeof access === 'function') {
      const filtered = await access(
        { _path: 'profiles/1', name: 'A', email: 'a@b.c' },
        adminUser
      )
      expect(filtered).toEqual({ _path: 'profiles/1', name: 'A' })
    }
  })

  test('an existing FieldAccessMap is intersected with filterFields', async () => {
    // public read map is {name, email}; requesting ['name'] must drop email.
    const access = getMethodAccess(collections, 'profiles', 'GET', publicUser, [
      'name',
    ])
    expect(typeof access).toBe('function')
    if (typeof access === 'function') {
      const filtered = await access(
        { _path: 'profiles/1', name: 'A', email: 'a@b.c' },
        publicUser
      )
      expect(filtered).toEqual({ _path: 'profiles/1', name: 'A' })
    }
  })

  test('intersection does not mutate the shared COLLECTIONS config', () => {
    // A field-filtered call must not strip keys from the config's own map, or a
    // later un-filtered call would wrongly inherit the narrower field set.
    getMethodAccess(collections, 'profiles', 'GET', publicUser, ['name'])
    const publicRead = collections.profiles.access?.[ROLES.public]?.read
    expect(publicRead).toEqual({ name: ALL, email: ALL })
  })
})
