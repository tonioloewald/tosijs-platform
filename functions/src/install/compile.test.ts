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

import {
  compileManifest,
  compileVisibility,
  compileGrant,
  compileCollection,
} from './compile'
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

describe('lte/gte — added for capability ceilings (#11)', () => {
  const vis = (op: 'lte' | 'gte', value: unknown) =>
    compileVisibility({ field: 'bytes', op, value } as never)

  test('numbers compare numerically', () => {
    expect(vis('lte', 1000)({ bytes: 999 })).toBe(true)
    expect(vis('lte', 1000)({ bytes: 1000 })).toBe(true)
    expect(vis('lte', 1000)({ bytes: 1001 })).toBe(false)
    expect(vis('gte', 1000)({ bytes: 1001 })).toBe(true)
    expect(vis('gte', 1000)({ bytes: 999 })).toBe(false)
  })

  test('strings compare lexically — for date cutoffs', () => {
    const before = compileVisibility({
      field: 'date',
      op: 'lte',
      value: '2026-01-01',
    } as never)
    expect(before({ date: '2025-12-31' })).toBe(true)
    expect(before({ date: '2026-06-01' })).toBe(false)
  })

  test('MISMATCHED TYPES DENY — never coerce', () => {
    // `'10' <= 9` is a comparison nobody meant, and for a ceiling a surprising
    // `true` is granted excess. So a type mismatch is a denial, not a guess.
    expect(vis('lte', 1000)({ bytes: '999' })).toBe(false)
    expect(vis('lte', '1000')({ bytes: 999 })).toBe(false)
    expect(vis('gte', 0)({ bytes: true })).toBe(false)
    expect(vis('lte', 1000)({ bytes: null })).toBe(false)
  })

  test('an ABSENT field denies a ceiling', () => {
    // "no bytes declared" must not read as "within the limit".
    expect(vis('lte', 1000)({})).toBe(false)
  })

  test('an unknown op still denies', () => {
    expect(
      compileVisibility({ field: 'x', op: 'sorta-lte' } as never)({ x: 1 })
    ).toBe(false)
  })
})

describe('envelope.seq compiles to the commit-path flag (#14)', () => {
  test('declared true, it is set', () => {
    const c = compileCollection({
      schema: { type: 'object' },
      envelope: { seq: true },
      access: [{ role: 'author', read: 'ALL' }],
    } as never)
    expect(c.seq).toBe(true)
  })

  test('absent or false, it is not — a sequence is opt-IN', () => {
    // A total order serialises writes to the collection. Defaulting it on
    // would put every collection behind one counter document without anyone
    // choosing that.
    for (const envelope of [undefined, { seq: false }] as never[]) {
      const c = compileCollection({
        schema: { type: 'object' },
        envelope,
        access: [{ role: 'author', read: 'ALL' }],
      } as never)
      expect(c.seq).toBeUndefined()
    }
  })

  test('it composes with envelope.version rather than replacing it', () => {
    const c = compileCollection({
      schema: { type: 'object' },
      envelope: { seq: true, version: { bumpOn: ['source'] } },
      access: [{ role: 'author', read: 'ALL' }],
    } as never)
    expect(c.seq).toBe(true)
    expect(typeof c.validate).toBe('function')
  })
})

describe('derive: principal reads the REQUEST principal (#18)', () => {
  // It was compiled with `principal: {}` hardcoded, so it produced `''` for
  // everyone — a declared feature wired to nothing. A collection is compiled
  // once and cached across requests, so anything captured at compile time
  // would be whoever happened to trigger the compile.
  const config = compileCollection({
    schema: { type: 'object' },
    derive: [{ op: 'principal', to: 'author', field: 'uid' }],
    access: [{ role: 'author', write: 'ALL' }],
  } as never)

  const who = (over = {}) =>
    ({ name: 'Ada', userIds: ['uid-9'], _id: 'role-3', roles: [], contacts: [], ...over }) as never

  test('it fills from the caller', async () => {
    const out = await config.validate!({ t: 'x' }, who(), {})
    expect((out as Record<string, unknown>).author).toBe('uid-9')
  })

  test('two callers get two answers — the whole point', async () => {
    const a = await config.validate!({ t: 'x' }, who(), {})
    const b = await config.validate!({ t: 'x' }, who({ userIds: ['uid-2'] }), {})
    expect((a as Record<string, unknown>).author).toBe('uid-9')
    expect((b as Record<string, unknown>).author).toBe('uid-2')
  })

  test('a value the caller SUPPLIED wins — a derive is a default', async () => {
    const out = await config.validate!({ t: 'x', author: 'chosen' }, who(), {})
    expect((out as Record<string, unknown>).author).toBe('chosen')
  })

  test('an unattributable caller leaves it ABSENT, not empty-string', async () => {
    // `author: ''` passes a `type: string` schema, means nothing, and then
    // blocks the default on every later write because the field is set.
    const out = await config.validate!({ t: 'x' }, { userIds: [] } as never, {})
    expect('author' in (out as Record<string, unknown>)).toBe(false)
  })

  test('name and roleId resolve too', async () => {
    const byName = compileCollection({
      schema: { type: 'object' },
      derive: [
        { op: 'principal', to: 'who', field: 'name' },
        { op: 'principal', to: 'roleRef', field: 'roleId' },
      ],
      access: [{ role: 'author', write: 'ALL' }],
    } as never)
    const out = (await byName.validate!({ t: 'x' }, who(), {})) as Record<string, unknown>
    expect(out.who).toBe('Ada')
    expect(out.roleRef).toBe('role-3')
  })
})

describe('immutable compiles to the pipeline flag (#25)', () => {
  const compile = (immutable?: boolean) =>
    compileCollection({
      schema: { type: 'object' },
      ...(immutable === undefined ? {} : { immutable }),
      access: [{ role: 'author', read: 'ALL' }],
    } as never)

  test('declared true, it is set', () => {
    // It was accepted by the validator and compiled to NOTHING before #25 — a
    // manifest could declare its log immutable and every writer could still
    // rewrite it. A declared guarantee wired to nothing is worse than none.
    expect(compile(true).immutable).toBe(true)
  })

  test('absent or false, it is not', () => {
    expect(compile().immutable).toBeUndefined()
    expect(compile(false).immutable).toBeUndefined()
  })
})
