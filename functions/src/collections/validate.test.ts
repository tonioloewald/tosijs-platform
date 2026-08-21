// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { test, expect, describe } from 'bun:test'
import { validate as schemaValidate, type ErrorHandler } from 'tosijs-schema'

import { COLLECTIONS } from './index'
import './module' // side-effect import: registers COLLECTIONS.module
import { ROLES, UserRoles, RoleName } from './roles'

import { ModuleSchema } from '../../shared/module'
import { PostSchema } from '../../shared/post'
import { PageSchema } from '../../shared/page'
import { RoleSchema } from '../../shared/role'

/**
 * Characterization tests for the write-path `validate` / schema legs.
 *
 * These pin the *current* behavior so the tjs-lang port (see ROADMAP.md Phase 1)
 * has an executable oracle. They cover the pieces that are pure and importable
 * without Firebase emulators:
 *   - each collection's `validate(data, userRoles, existing)` — the `existing`
 *     (provenance) argument in particular has had zero coverage.
 *   - the tosijs-schema validation leg exactly as doc.ts runs it.
 *
 * NOT covered here (require emulators / mocks, deferred to integration):
 *   - `unique` (isUnique → Firestore query)
 *   - COLLECTIONS.post.validate (calls clearBlogCache → Firestore write)
 *   - the provenance merge / stamping inline in the doc handler
 */

const createUserRoles = (roles: string[]): UserRoles => ({
  name: 'Test User',
  contacts: [{ type: 'email', value: 'test@example.com' }],
  roles: roles as RoleName[],
  userIds: ['test-uid'],
})

// Mirror of doc.ts:validateWithSchema so these tests exercise the exact
// schema-validation leg the write path runs (the ErrorHandler-callback form).
const validateWithSchema = (
  data: any,
  schema: any
): { valid: boolean; errors: { path: string; message: string }[] } => {
  const errors: { path: string; message: string }[] = []
  const onError: ErrorHandler = (path, message) =>
    errors.push({ path, message })
  const valid = schemaValidate(data, schema, onError)
  return { valid, errors }
}

describe('COLLECTIONS.module.validate — revision provenance (uses `existing`)', () => {
  const roles = createUserRoles([ROLES.developer])
  // module.ts registers this validate on import; guard doubles as a smoke test.
  const moduleValidate = COLLECTIONS.module.validate
  if (!moduleValidate) {
    throw new Error('COLLECTIONS.module.validate was not registered on import')
  }

  test('is registered by the side-effect import', () => {
    expect(typeof moduleValidate).toBe('function')
  })

  test('create with existing === undefined initializes revisions to 0', async () => {
    const out = await moduleValidate(
      { name: 'm', source: 'x', version: '1.0.0', tags: [] },
      roles,
      undefined
    )
    expect(out).not.toBeInstanceOf(Error)
    expect(out.revisions).toBe(0)
  })

  test('a source change increments the previous revision count', async () => {
    const out = await moduleValidate(
      { name: 'm', source: 'NEW', version: '1.0.1', tags: [] },
      roles,
      { source: 'OLD', revisions: 3 }
    )
    expect(out.revisions).toBe(4)
  })

  test('unchanged source leaves revisions untouched (passthrough)', async () => {
    const out = await moduleValidate(
      { name: 'm', source: 'SAME', version: '1.0.0', revisions: 7, tags: [] },
      roles,
      { source: 'SAME', revisions: 7 }
    )
    expect(out.revisions).toBe(7)
  })

  // Regression: doc.ts passes `existing = {}` (not undefined) on create. An empty
  // object must be treated as a create (revisions = 0), not an update — this was
  // previously producing `undefined + 1` === NaN.
  test('treats empty `existing` ({}) from the create pipeline as revisions = 0', async () => {
    const out = await moduleValidate(
      { name: 'm', source: 'x', version: '1.0.0', tags: [] },
      roles,
      {}
    )
    expect(out.revisions).toBe(0)
  })

  test('source change with an existing record missing `revisions` yields 1 (not NaN)', async () => {
    const out = await moduleValidate(
      { name: 'm', source: 'NEW', version: '1.0.1', tags: [] },
      roles,
      { source: 'OLD' } // legacy record with no revisions field
    )
    expect(out.revisions).toBe(1)
  })
})

describe('schema validation leg (mirrors doc.ts:validateWithSchema)', () => {
  describe('ModuleSchema', () => {
    test('accepts a well-formed module', () => {
      expect(
        validateWithSchema(
          {
            name: 'm',
            source: 's',
            version: '1.2.3',
            revisions: 0,
            tags: ['public'],
          },
          ModuleSchema
        ).valid
      ).toBe(true)
    })

    test('rejects a non-semver version', () => {
      const { valid, errors } = validateWithSchema(
        { name: 'm', source: 's', version: 'v1', revisions: 0, tags: [] },
        ModuleSchema
      )
      expect(valid).toBe(false)
      expect(errors.length).toBeGreaterThan(0)
    })

    test('rejects negative revisions', () => {
      expect(
        validateWithSchema(
          { name: 'm', source: 's', version: '1.0.0', revisions: -1, tags: [] },
          ModuleSchema
        ).valid
      ).toBe(false)
    })

    test('rejects a module missing required fields', () => {
      expect(validateWithSchema({ name: 'm' }, ModuleSchema).valid).toBe(false)
    })
  })

  describe('PostSchema', () => {
    test('requires title and content; path is optional', () => {
      expect(
        validateWithSchema({ title: 'T', content: 'C' }, PostSchema).valid
      ).toBe(true)
      expect(validateWithSchema({ title: 'T' }, PostSchema).valid).toBe(false)
    })
  })

  describe('PageSchema', () => {
    test('requires title, description, path, imageUrl, and source', () => {
      expect(
        validateWithSchema(
          {
            title: 't',
            description: 'd',
            path: 'p',
            imageUrl: 'i',
            source: 's',
          },
          PageSchema
        ).valid
      ).toBe(true)
      expect(validateWithSchema({ title: 't' }, PageSchema).valid).toBe(false)
    })
  })

  describe('RoleSchema', () => {
    test('accepts a role with a valid email contact', () => {
      expect(
        validateWithSchema(
          {
            name: 'admins',
            contacts: [{ type: 'email', value: 'a@b.com' }],
            roles: ['admin'],
            userIds: [],
          },
          RoleSchema
        ).valid
      ).toBe(true)
    })

    test('rejects an invalid email in a contact union member', () => {
      expect(
        validateWithSchema(
          {
            name: 'admins',
            contacts: [{ type: 'email', value: 'not-an-email' }],
            roles: ['admin'],
            userIds: [],
          },
          RoleSchema
        ).valid
      ).toBe(false)
    })
  })
})
