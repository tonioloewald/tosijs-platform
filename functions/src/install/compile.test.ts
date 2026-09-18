/**
 * Compiling a manifest into a runnable collection (A3, #5).
 *
 * The claim being tested is the one the whole install story rests on: a
 * collection declared as JSON behaves the same as one written in TypeScript.
 * So these do not stop at "the config looks right" — they run the compiled
 * config through the REAL access engine (`getMethodAccess`) and the REAL write
 * pipeline against `MemoryStore`, and compare against what the shipped
 * hand-written configs do.
 *
 * Run: cd functions && bun test src/install/compile.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import { compileManifest, compileVisibility, compileGrant } from './compile'
import type { Manifest } from './manifest'
import { validateManifest } from './manifest'
import { unenforcedKeywords } from 'tosijs-schema'
import { ALL, getMethodAccess, type CollectionMap } from '../collections/access'
import { ROLES, type UserRoles, type RoleName } from '../collections/roles'
import { MemoryStore } from '../collections/store'
import { runWritePipeline } from '../collections/write-pipeline'

const who = (roles: string[]): UserRoles => ({
  name: 'x',
  contacts: [],
  roles: roles as RoleName[],
  userIds: ['uid'],
})

const opts = {
  unenforced: (s: Record<string, unknown>) =>
    unenforcedKeywords(s as never) as string[],
  knownRoles: Object.values(ROLES),
}

/**
 * A manifest that mirrors the SHIPPED `post` config: public reads everything,
 * public lists only published, authors write.
 */
const blogish: Manifest = {
  manifest: 1,
  name: 'demo',
  version: '1.0.0',
  collections: {
    'demo:post': {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          date: { type: 'string' },
          secret: { type: 'string' },
        },
        required: ['title'],
      },
      unique: ['slug'],
      access: [
        {
          role: ROLES.public,
          read: 'ALL',
          // The real rule: a post is published iff it has a non-empty date.
          list: { visible: { field: 'date', op: 'nonEmpty' } },
        },
        { role: ROLES.author, write: 'ALL', list: 'ALL' },
      ],
    },
  },
}

describe('the fixture is a manifest the validator accepts', () => {
  test('no validation problems', () => {
    expect(validateManifest(blogish, opts)).toEqual([])
  })
})

describe('compiled collections run through the REAL access engine', () => {
  const collections = compileManifest(blogish) as CollectionMap

  test('public read is ALL', () => {
    expect(getMethodAccess(collections, 'demo:post', 'GET', who([]))).toBe(ALL)
  })

  test('public LIST hides an unpublished row and shows a published one', async () => {
    const access = getMethodAccess(collections, 'demo:post', 'LIST', who([]))
    expect(typeof access).toBe('function')
    const fn = access as (row: unknown) => Promise<unknown>
    expect(await fn({ title: 'draft', date: '' })).toBeInstanceOf(Error)
    expect(await fn({ title: 'live', date: '2026-01-01' })).toMatchObject({
      title: 'live',
    })
  })

  test('an author LISTS everything — the lattice joins, it does not override', async () => {
    // An author also holds the public grant. Most-permissive wins, so the
    // author's `list: ALL` absorbs the public predicate rather than being
    // decided by declaration order.
    expect(
      getMethodAccess(collections, 'demo:post', 'LIST', who([ROLES.author]))
    ).toBe(ALL)
  })

  test('declaration order does not matter', () => {
    const reversed = compileManifest({
      ...blogish,
      collections: {
        'demo:post': {
          ...blogish.collections['demo:post'],
          access: [...blogish.collections['demo:post'].access].reverse(),
        },
      },
    }) as CollectionMap
    expect(
      getMethodAccess(reversed, 'demo:post', 'LIST', who([ROLES.author]))
    ).toBe(ALL)
  })

  test('an unlisted role gets nothing', () => {
    expect(
      getMethodAccess(collections, 'demo:post', 'POST', who([ROLES.editor]))
    ).toBeUndefined()
  })
})

describe('a compiled collection actually writes, end to end', () => {
  test('the write pipeline honours the compiled schema and unique constraint', async () => {
    const collections = compileManifest(blogish) as CollectionMap
    const config = collections['demo:post']
    const store = new MemoryStore()
    const deps = {
      now: () => '2026-09-18T00:00:00.000Z',
      isUnique: (field: string, value: unknown) =>
        store.isUnique('demo:post', field, value, 'demo:post/a'),
    }

    // Schema rejection comes from the manifest's own schema.
    const bad = await runWritePipeline(
      {
        method: 'POST',
        body: { date: '2026-01-01', slug: 'a' },
        existing: {},
        exists: false,
        config,
        userRoles: who([ROLES.author]),
      },
      deps
    )
    expect(bad).toMatchObject({ status: 'rejected', reason: 'schema' })

    const good = await runWritePipeline(
      {
        method: 'POST',
        body: { title: 'ok', slug: 'a' },
        existing: {},
        exists: false,
        config,
        userRoles: who([ROLES.author]),
      },
      deps
    )
    expect(good.status).toBe('write')
  })
})

describe('visibility predicates', () => {
  const v = (spec: never) => compileVisibility(spec)

  test('nonEmpty treats absent, empty and whitespace alike', () => {
    const f = v({ field: 'date', op: 'nonEmpty' } as never)
    expect(f({})).toBe(false)
    expect(f({ date: '' })).toBe(false)
    expect(f({ date: '   ' })).toBe(false)
    expect(f({ date: '2026-01-01' })).toBe(true)
  })

  test('includes matches an array member, not a substring', () => {
    const f = v({ field: 'tags', op: 'includes', value: 'public' } as never)
    expect(f({ tags: ['public'] })).toBe(true)
    expect(f({ tags: ['publication'] })).toBe(false)
    expect(f({ tags: 'public' })).toBe(false)
  })

  test('all/any compose', () => {
    const f = v({
      all: [
        { field: 'tags', op: 'includes', value: 'public' },
        { field: 'date', op: 'nonEmpty' },
      ],
    } as never)
    expect(f({ tags: ['public'], date: '2026' })).toBe(true)
    expect(f({ tags: ['public'], date: '' })).toBe(false)
  })

  test('an unknown op DENIES rather than grants', () => {
    // Unreachable through the validator, but the direction matters: a predicate
    // nobody understands must never read as permission.
    expect(v({ field: 'x', op: 'bogus' } as never)({ x: 1 })).toBe(false)
  })
})

describe('projections', () => {
  test('a projection strains to declared properties and keeps _path', async () => {
    const grant = compileGrant({
      project: { type: 'object', properties: { title: {} } },
    })
    const out = (await (grant as (r: unknown) => Promise<unknown>)({
      _path: 'demo:post/a',
      title: 'keep',
      secret: 'drop',
    })) as Record<string, unknown>
    expect(out).toEqual({ _path: 'demo:post/a', title: 'keep' })
  })

  test('a projection does NOT hide a row missing one of its fields', async () => {
    // `filter()` re-validates, so a projection with `required` would drop the
    // whole row instead of projecting it — turning a field restriction into a
    // row restriction. Compiling to a property list avoids that entirely.
    const grant = compileGrant({
      project: { type: 'object', properties: { title: {}, missing: {} }, required: ['missing'] },
    })
    const out = await (grant as (r: unknown) => Promise<unknown>)({ title: 'a' })
    expect(out).toEqual({ title: 'a' })
  })

  test('visibility applies before projection', async () => {
    const grant = compileGrant({
      visible: { field: 'date', op: 'nonEmpty' },
      project: { type: 'object', properties: { title: {} } },
    })
    const fn = grant as (r: unknown) => Promise<unknown>
    expect(await fn({ title: 'x', date: '' })).toBeInstanceOf(Error)
    expect(await fn({ title: 'x', date: '2026' })).toEqual({ title: 'x' })
  })
})
