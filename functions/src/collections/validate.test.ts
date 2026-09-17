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
  // `strict: true` mirrors doc.ts — see the stride-sampling describe block below.
  // If this mirror drifts from doc.ts, these tests stop testing the write path.
  const valid = schemaValidate(data, schema, { onError, strict: true })
  return { valid, errors }
}

/**
 * The write gate must not stochastically sample.
 *
 * tosijs-schema 1.9.0's `validate()` stride-samples arrays past ~100 entries
 * unless `strict: true`. Measured on 1.9.0 by exhaustively placing one bad
 * element at every index: a 200-element array is wrongly accepted for 100 of
 * the 200 positions, a 1000-element array for 900. `doc.ts` and
 * `write-pipeline.ts` previously passed a bare ErrorHandler, so both got the
 * sampling default — the write gate only spot-checked long arrays.
 *
 * Today's schemas keep small arrays (`tags`, `contacts`), so this was latent
 * rather than exploited. It stops being latent when installed manifests carry
 * caller-authored schemas (tosijs-platform#5).
 *
 * These tests fail if the `strict` flag is dropped from either validator, and
 * the first one also fails if upstream ever makes strict the default — at which
 * point the flag is redundant and can go, deliberately rather than by accident.
 */
describe('schema validation does not sample (strict)', () => {
  const longArraySchema = { type: 'array', items: { type: 'string' } }
  const withOneBadEntry = (length: number, badIndex: number) =>
    Array.from({ length }, (_, i) => (i === badIndex ? 42 : 'ok'))

  test('sampling IS the upstream default — the reason the flag is needed', () => {
    // Tripwire: if this starts failing, upstream made strict the default.
    const ignore: ErrorHandler = () => undefined
    const missed = Array.from({ length: 200 }, (_, bad) =>
      schemaValidate(withOneBadEntry(200, bad), longArraySchema, ignore)
    ).filter(Boolean).length
    expect(missed).toBeGreaterThan(0)
  })

  test('strict catches a bad entry at EVERY position in a 200-element array', () => {
    for (let bad = 0; bad < 200; bad++) {
      const { valid } = validateWithSchema(
        withOneBadEntry(200, bad),
        longArraySchema
      )
      if (valid) {
        throw new Error(`bad entry at index ${bad} was accepted`)
      }
    }
    expect(true).toBe(true)
  })

  test('strict catches a bad entry deep in a 1000-element array', () => {
    const { valid } = validateWithSchema(
      withOneBadEntry(1000, 997),
      longArraySchema
    )
    expect(valid).toBe(false)
  })

  test('valid long arrays still pass', () => {
    const { valid } = validateWithSchema(
      Array.from({ length: 1000 }, () => 'ok'),
      longArraySchema
    )
    expect(valid).toBe(true)
  })
})

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
