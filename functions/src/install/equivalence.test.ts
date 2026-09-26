/**
 * EQUIVALENCE: the data-driven configs must behave exactly like the compiled
 * ones they replace (#5).
 *
 * Before `/doc` is switched onto the registry, the collections that exist today
 * as TypeScript have to be shown to survive the translation. This is the oracle
 * for that swap, at the unit level — `verify:prod` is the same question asked of
 * a deployment.
 *
 * The comparison is against the REAL shipped behaviour, not a restatement of it:
 * `module`'s revision provenance is checked against the live
 * `COLLECTIONS.module.validate`, and `post`'s slug rule against the same inputs
 * `blog.ts` handles.
 *
 * Run: cd functions && bun test src/install/equivalence.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import { compileCollection } from './compile'
import type { InstalledCollection } from './manifest'
import { validateManifest } from './manifest'
import { unenforcedKeywords } from 'tosijs-schema'
import { ALL, getMethodAccess, type CollectionMap } from '../collections/access'
import { ROLES, type UserRoles, type RoleName } from '../collections/roles'
import { COLLECTIONS } from '../collections'
import '../collections/module'

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

/** `post` as data — the declarative form of what blog.ts hand-writes. */
const POST_AS_DATA: InstalledCollection = {
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string' },
      path: { type: 'string' },
      date: { type: 'string' },
    },
    required: ['title', 'content'],
  },
  unique: ['title', 'path'],
  // Replaces blog.ts's `validate`, which auto-generates a path from the title.
  derive: [{ op: 'slug', to: 'path', from: 'title', when: 'absent' }],
  access: [
    {
      role: ROLES.public,
      read: 'ALL',
      // Replaces the `isPublished` predicate: a post is published iff it has a
      // non-empty date. D11's three "empty" shapes all count as unpublished.
      list: { visible: { field: 'date', op: 'nonEmpty' } },
    },
    { role: ROLES.author, write: 'ALL', list: 'ALL' },
  ],
}

/** `module` as data — including the revision provenance. */
const MODULE_AS_DATA: InstalledCollection = {
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      source: { type: 'string' },
      version: { type: 'string' },
      revisions: { type: 'number' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['name', 'source', 'version'],
  },
  unique: ['name'],
  envelope: { version: { bumpOn: ['source'] } },
  access: [
    {
      role: ROLES.public,
      read: { visible: { field: 'tags', op: 'includes', value: 'public' } },
      list: {
        visible: {
          all: [
            { field: 'tags', op: 'includes', value: 'public' },
            { field: 'tags', op: 'includes', value: 'visible' },
          ],
        },
      },
    },
    { role: ROLES.developer, read: 'ALL', write: 'ALL', list: 'ALL' },
  ],
}

describe('both are manifests the validator accepts', () => {
  test('no validation problems', () => {
    expect(
      validateManifest(
        {
          manifest: 1,
          name: 'platform',
          version: '1.0.0',
          collections: {
            'platform:post': POST_AS_DATA,
            'platform:module': MODULE_AS_DATA,
          },
        },
        opts
      )
    ).toEqual([])
  })
})

describe('post: the data form reproduces the shipped behaviour', () => {
  const collections = { post: compileCollection(POST_AS_DATA) } as CollectionMap

  test('public reads everything, as today', () => {
    expect(getMethodAccess(collections, 'post', 'GET', who([]))).toBe(ALL)
  })

  test('the public LIST hides drafts — all three "empty" shapes', async () => {
    // The live leak this rule exists for: 57 unpublished posts were listed
    // because the guard tested `date !== undefined` while unpublish() writes ''.
    const fn = getMethodAccess(collections, 'post', 'LIST', who([])) as (
      r: unknown
    ) => Promise<unknown>
    for (const row of [{ title: 'a' }, { title: 'a', date: '' }, { title: 'a', date: '   ' }]) {
      expect(await fn(row)).toBeInstanceOf(Error)
    }
    expect(await fn({ title: 'a', date: '2026-01-01' })).toMatchObject({
      title: 'a',
    })
  })

  test('an author writes and lists everything', () => {
    expect(getMethodAccess(collections, 'post', 'POST', who([ROLES.author]))).toBe(ALL)
    expect(getMethodAccess(collections, 'post', 'LIST', who([ROLES.author]))).toBe(ALL)
  })

  test('the slug is generated from the title when absent', async () => {
    const validate = compileCollection(POST_AS_DATA).validate as (
      d: unknown,
      r: unknown,
      e: unknown
    ) => Promise<Record<string, unknown>>
    const out = await validate({ title: 'Hello, World!' }, who([]), {})
    expect(out.path).toBe('hello-world')
  })

  test('a supplied slug is NORMALISED, not trusted verbatim', async () => {
    // blog.ts slugifies whatever the author typed too, so a hand-entered slug
    // and a generated one cannot disagree about what is legal.
    const validate = compileCollection(POST_AS_DATA).validate as never as (
      d: unknown,
      r: unknown,
      e: unknown
    ) => Promise<Record<string, unknown>>
    expect((await validate({ title: 'T', path: 'Hello World!' }, who([]), {})).path).toBe(
      'hello-world'
    )
  })
})

describe('module: revision provenance matches the SHIPPED validate exactly', () => {
  const compiled = compileCollection(MODULE_AS_DATA)
  const shipped = COLLECTIONS.module?.validate as (
    d: Record<string, unknown>,
    r: UserRoles,
    e: Record<string, unknown>
  ) => Promise<Record<string, unknown>>

  const cases: Array<{
    label: string
    data: Record<string, unknown>
    existing: Record<string, unknown>
  }> = [
    { label: 'create', data: { name: 'a', source: 'x' }, existing: {} },
    {
      label: 'source changed',
      data: { name: 'a', source: 'y' },
      existing: { name: 'a', source: 'x', revisions: 3 },
    },
    {
      label: 'source unchanged — must CARRY FORWARD',
      data: { name: 'a', source: 'x', tags: ['new'] },
      existing: { name: 'a', source: 'x', revisions: 7 },
    },
    {
      label: 'legacy record with no revisions count',
      data: { name: 'a', source: 'y' },
      existing: { name: 'a', source: 'x' },
    },
  ]

  for (const c of cases) {
    test(`${c.label}: data form agrees with the shipped one`, async () => {
      const dataForm = await (
        compiled.validate as never as (
          d: unknown,
          r: unknown,
          e: unknown
        ) => Promise<Record<string, unknown>>
      )(c.data, who([]), c.existing)
      const shippedForm = await shipped(
        { ...c.data },
        who([ROLES.developer]),
        c.existing
      )
      expect(dataForm.revisions).toBe(shippedForm.revisions as number)
    })
  }

  test('the carry-forward case is the one that once erased history', async () => {
    // A PUT that did not change `source` silently reset the count to nothing,
    // because PUT replaces and the branch never reassigned the field.
    const out = await (
      compiled.validate as never as (
        d: unknown,
        r: unknown,
        e: unknown
      ) => Promise<Record<string, unknown>>
    )({ name: 'a', source: 'x' }, who([]), { source: 'x', revisions: 7 })
    expect(out.revisions).toBe(7)
  })

  test('public read requires the public tag; developer reads all', async () => {
    const collections = { module: compiled } as CollectionMap
    const pub = getMethodAccess(collections, 'module', 'GET', who([])) as (
      r: unknown
    ) => Promise<unknown>
    expect(await pub({ tags: ['private'] })).toBeInstanceOf(Error)
    expect(await pub({ tags: ['public'] })).toMatchObject({ tags: ['public'] })
    expect(
      getMethodAccess(collections, 'module', 'GET', who([ROLES.developer]))
    ).toBe(ALL)
  })

  test('public LIST needs BOTH public and visible', async () => {
    const collections = { module: compiled } as CollectionMap
    const fn = getMethodAccess(collections, 'module', 'LIST', who([])) as (
      r: unknown
    ) => Promise<unknown>
    expect(await fn({ tags: ['public'] })).toBeInstanceOf(Error)
    expect(await fn({ tags: ['public', 'visible'] })).toMatchObject({})
  })
})
