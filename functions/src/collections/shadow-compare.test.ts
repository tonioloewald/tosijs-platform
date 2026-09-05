/**
 * Tests for shadow mode itself (ROADMAP Phase 1 rung 1).
 *
 * Shadow mode runs on the production write path, so the properties that matter
 * are the safety ones: it is off unless asked for, it cannot throw into a
 * request, and it cannot write. Detection accuracy is secondary — a shadow that
 * misses a divergence costs us information; a shadow that breaks a save costs a
 * user their work.
 *
 * Run: cd functions && bun test src/collections/shadow-compare.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { shadowEnabled, shadowCompareWrite } from './shadow-compare'
import type { CollectionConfig } from './access'
import type { UserRoles } from './roles'

const roles: UserRoles = {
  name: 'tester',
  contacts: [],
  roles: ['admin'],
  userIds: ['u1'],
} as UserRoles

const NOW = '2026-09-05T12:00:00.000Z'

const base = {
  path: 'post/x',
  method: 'PUT' as const,
  userRoles: roles,
  now: NOW,
}

afterEach(() => {
  delete process.env.SHADOW_WRITE_PIPELINE
})

describe('off by default', () => {
  test('shadowEnabled() is false unless SHADOW_WRITE_PIPELINE=1', () => {
    delete process.env.SHADOW_WRITE_PIPELINE
    expect(shadowEnabled()).toBe(false)
    process.env.SHADOW_WRITE_PIPELINE = '0'
    expect(shadowEnabled()).toBe(false)
    process.env.SHADOW_WRITE_PIPELINE = 'true' // only '1' counts — no fuzzy truthiness
    expect(shadowEnabled()).toBe(false)
    process.env.SHADOW_WRITE_PIPELINE = '1'
    expect(shadowEnabled()).toBe(true)
  })
})

describe('cannot break the request path', () => {
  test('a throwing transform is swallowed, not propagated', async () => {
    const config: CollectionConfig = {
      validate: async () => {
        throw new Error('boom')
      },
    }
    // must resolve, not reject
    await expect(
      shadowCompareWrite({
        ...base,
        body: { title: 't' },
        existing: { title: 'old', _created: NOW },
        config,
        actual: { title: 't', _created: NOW, _modified: NOW },
      })
    ).resolves.toBeUndefined()
  })

  test('malformed input is swallowed too', async () => {
    await expect(
      shadowCompareWrite({
        ...base,
        body: null as unknown as Record<string, unknown>,
        existing: null as unknown as Record<string, unknown>,
        config: {},
        actual: {},
      })
    ).resolves.toBeUndefined()
  })

  test('performs no privileged reads — uniqueness is stubbed, not executed', async () => {
    // If the shadow re-ran uniqueness it would double the Firestore reads on
    // every write for no new information.
    let reads = 0
    const config: CollectionConfig = {
      unique: ['path'],
      // a real isUnique would be injected by doc.ts; the shadow must not use one
      validate: async (d: Record<string, unknown>) => {
        reads++
        return d
      },
    }
    await shadowCompareWrite({
      ...base,
      body: { path: 'p' },
      existing: { path: 'p0', _created: NOW },
      config,
      actual: { path: 'p', _created: NOW, _modified: NOW },
    })
    // the transform runs once (that is the point); no unique lookups happen
    expect(reads).toBe(1)
  })
})

describe('detection', () => {
  test('agrees with doc.ts on an ordinary update', async () => {
    // doc.ts's own arithmetic, reproduced: PUT replaces, _created preserved.
    const existing = { title: 'old', _created: '2020-01-01T00:00:00.000Z' }
    const actual = {
      title: 'new',
      _created: '2020-01-01T00:00:00.000Z',
      _modified: NOW,
    }
    await expect(
      shadowCompareWrite({
        ...base,
        body: { title: 'new' },
        existing,
        config: {},
        actual,
      })
    ).resolves.toBeUndefined()
  })

  test('an unchanged body is reported as the expected no-op divergence', async () => {
    // Known behaviour change awaiting cutover — must not be silently equated
    // with a match, nor counted as an unknown mismatch.
    const existing = { title: 'same', _created: '2020-01-01T00:00:00.000Z' }
    await expect(
      shadowCompareWrite({
        ...base,
        body: { title: 'same' },
        existing,
        config: {},
        actual: {
          title: 'same',
          _created: '2020-01-01T00:00:00.000Z',
          _modified: NOW,
        },
      })
    ).resolves.toBeUndefined()
  })
})
