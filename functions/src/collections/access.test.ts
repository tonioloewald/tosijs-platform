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
