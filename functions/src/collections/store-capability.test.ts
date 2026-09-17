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

  /**
   * CHANGED 2026-09-17 with the access-lattice join, and the change is the
   * point rather than a casualty of it.
   *
   * This asserted that an editor sees `title` but NOT `body`, because the
   * `editor` field map replaced the `public` predicate under the old
   * last-match-wins walk. That restriction was never real: an editor is also a
   * member of the public, and `public.read` returns the WHOLE row for a
   * published post. The editor could see `body` at any time by simply not
   * sending their token. Measured, both before and after:
   *
   *     anonymous  body = "secret-A"
   *     editor     body = "secret-A"   (after the join)
   *     editor     body = undefined    (before — while anonymous still saw it)
   *
   * So the old behaviour restricted the *more* privileged principal and left
   * the *less* privileged one unrestricted — an illusory control that read as
   * enforcement. The lattice unions grants, so a role can never see less than
   * the public grant it also holds. Monotonicity, which is what D5 asks for.
   *
   * To actually hide `body` from editors, `public.read` must stop returning it.
   * A narrower role grant cannot claw back what public already gives away.
   */
  test('editor sees at least what public sees — a role never grants less', async () => {
    const editor = capFor([ROLES.editor])
    const pub = capFor([])
    const asEditor = (await editor.get('post/a')) as Record<string, unknown>
    const asPublic = (await pub.get('post/a')) as Record<string, unknown>

    expect(asEditor.title).toBe('A')
    // The honest assertion: whatever public can see, the editor can see.
    for (const key of Object.keys(asPublic)) {
      expect(asEditor[key]).toEqual(asPublic[key])
    }
  })

  test('a field map DOES strain when no wider grant applies', async () => {
    // The projection still works — it just cannot undercut `public`. Here the
    // row is unpublished, so the public predicate denies and only the editor's
    // field map grants, which is exactly when straining is meaningful.
    const editor = capFor([ROLES.editor])
    const doc = (await editor.get('post/b')) as Record<string, unknown>
    expect(doc?.title).toBe('B')
    expect(doc?.body).toBeUndefined()
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
