// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { test, expect, describe } from 'bun:test'

import { ALL, type CollectionMap } from './access'
import { ROLES, type UserRoles, type RoleName } from './roles'
import { makeStoreCapability, runProcedure, type DocStore } from './store-capability'

/**
 * Token pass-through (UNIVERSAL-ENDPOINT.md §2.1). Proves that a capability bound
 * to a principal grants exactly the caller's rights, and that a procedure handed
 * that capability reads *identically* to a direct call — over the REAL access
 * engine (getMethodAccess), no VM required.
 */

const principal = (roles: RoleName[]): UserRoles => ({
  name: 'test',
  contacts: [],
  roles,
  userIds: ['uid'],
})

// public sees only published posts (and only some fields); admin sees everything.
const COLLECTIONS: CollectionMap = {
  post: {
    access: {
      [ROLES.public]: {
        read: async (p: any) =>
          p.published ? p : new Error('unpublished'),
        list: async (p: any) =>
          p.published ? p : new Error('unpublished'),
      },
      // editor gets a field-restricted read (title + published only)
      [ROLES.editor]: {
        read: { title: ALL, published: ALL },
        list: { title: ALL, published: ALL },
      },
      [ROLES.admin]: { read: ALL, list: ALL },
    },
  },
}

const store: DocStore = {
  get: (path) =>
    ({
      'post/a': { title: 'A', body: 'secret-A', published: true },
      'post/b': { title: 'B', body: 'secret-B', published: false },
    } as Record<string, any>)[path],
  list: () => [
    { id: 'a', data: { title: 'A', body: 'secret-A', published: true } },
    { id: 'b', data: { title: 'B', body: 'secret-B', published: false } },
  ],
}

const capFor = (roles: RoleName[]) =>
  makeStoreCapability(COLLECTIONS, store, principal(roles))

describe('token pass-through: capability grants exactly the caller’s rights', () => {
  test('admin reads the full doc incl. an unpublished one', async () => {
    const admin = capFor([ROLES.admin])
    expect(await admin.get('post/b')).toMatchObject({ title: 'B', body: 'secret-B' })
  })

  test('public cannot read an unpublished doc (row filtered)', async () => {
    const pub = capFor([])
    expect(await pub.get('post/b')).toBeUndefined()
    expect(await pub.get('post/a')).toMatchObject({ title: 'A' })
  })

  test('editor read is field-strained (no body)', async () => {
    const editor = capFor([ROLES.editor])
    const doc = (await editor.get('post/a')) as Record<string, unknown>
    expect(doc.title).toBe('A')
    expect(doc.body).toBeUndefined()
  })

  test('list is filtered/strained per principal', async () => {
    expect(await capFor([ROLES.admin]).list('post')).toHaveLength(2)
    expect(await capFor([]).list('post')).toEqual([
      expect.objectContaining({ title: 'A' }),
    ]) // only the published one
  })
})

describe('a procedure reads identically to a direct call (same principal)', () => {
  // The procedure only ever receives the caller-bound capability.
  const readB = (cap: any) => cap.get('post/b')

  test('direct == via-procedure for admin', async () => {
    const admin = capFor([ROLES.admin])
    const direct = await admin.get('post/b')
    const viaProc = await runProcedure(admin, readB)
    expect(viaProc).toEqual(direct)
    expect(viaProc).toMatchObject({ body: 'secret-B' })
  })

  test('direct == via-procedure for public (both denied the unpublished doc)', async () => {
    const pub = capFor([])
    expect(await runProcedure(pub, readB)).toEqual(await pub.get('post/b'))
    expect(await runProcedure(pub, readB)).toBeUndefined()
  })

  test('no amplification: a procedure given the public cap cannot see what admin can', async () => {
    const pub = capFor([])
    // same store, same collection, same procedure — only the bound principal differs
    expect(await runProcedure(pub, readB)).toBeUndefined()
    expect(await runProcedure(capFor([ROLES.admin]), readB)).toMatchObject({
      body: 'secret-B',
    })
  })
})
