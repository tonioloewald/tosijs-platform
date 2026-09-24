/**
 * Installed collections reaching `/doc` and `/docs` (#5).
 *
 * Two questions, and they have opposite failure costs.
 *
 * **Does an installed collection work?** If not, virta is blocked — annoying,
 * loud, fixed in an afternoon.
 *
 * **Can an installed collection reach anything it should not?** If so, a
 * third-party manifest shadows `role` and rewrites the input to everyone's
 * authorization. Silent, and the blast radius is the whole host. So most of
 * this file is the second question.
 *
 * Run: cd functions && bun test src/install/installed.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import {
  configsFromInstalled,
  mergePlatformLast,
  collectionsFor,
} from './installed'
import { compileStored } from '../collections/registry'
import { COLLECTIONS } from '../collections'
import { ALL, getMethodAccess, type CollectionMap } from '../collections/access'
import { ROLES, type UserRoles, type RoleName } from '../collections/roles'
import type { Grant } from './apply'
import type { Manifest } from './manifest'
import '../collections/role'
import '../collections/config'

const who = (roles: string[]): UserRoles => ({
  name: 'x',
  contacts: [],
  roles: roles as RoleName[],
  userIds: ['uid'],
})

const grant = (over: Partial<Grant> = {}): Grant => ({
  name: 'virta',
  activeVersion: '1.0.0',
  status: 'active',
  capabilities: [],
  ...over,
})

const manifest = (
  collections: Record<string, unknown>,
  name = 'virta'
): Manifest =>
  ({
    manifest: 1,
    name,
    version: '1.0.0',
    collections,
  }) as Manifest

const TASK = {
  schema: { type: 'object', properties: { title: { type: 'string' } } },
  access: [{ role: ROLES.admin, read: 'ALL', write: 'ALL', list: 'ALL' }],
}

describe('an installed manifest becomes usable config', () => {
  const configs = configsFromInstalled([
    { grant: grant(), manifest: manifest({ 'virta:task': TASK }) },
  ])

  test('it produces a namespaced, provenanced entry', () => {
    expect(configs).toHaveLength(1)
    expect(configs[0]).toMatchObject({
      name: 'virta:task',
      namespace: 'virta',
      version: '1.0.0',
    })
  })

  test('it compiles and grants what the manifest said', () => {
    const { collections, failed } = compileStored(configs)
    expect(failed).toEqual([])
    expect(getMethodAccess(collections, 'virta:task', 'GET', who([ROLES.admin])))
      .toBe(ALL)
    // …and nothing to anyone else, by deny-default.
    expect(
      getMethodAccess(collections, 'virta:task', 'GET', who([ROLES.author]))
    ).toBeUndefined()
  })
})

describe('what a planted manifest cannot do', () => {
  // These matter because the manifest document lives in the datastore, so the
  // install endpoint is not the only way one can arrive: a direct write, a
  // restored backup, or a record installed before the rule tightened.
  const planted = (collections: Record<string, unknown>, name = 'virta') =>
    configsFromInstalled([{ grant: grant({ name }), manifest: manifest(collections, name) }])

  test('it cannot declare a BARE name — that is the platform"s space', () => {
    for (const bare of ['role', 'post', 'config', 'module', 'anything']) {
      expect(planted({ [bare]: TASK })).toEqual([])
    }
  })

  test('it cannot declare ANOTHER library"s namespace', () => {
    expect(planted({ 'other:task': TASK })).toEqual([])
  })

  test('the refusal is per-collection, not per-manifest', () => {
    // One bad key must not take the whole library down, and must not smuggle
    // the rest of the library in either.
    const configs = planted({ role: TASK, 'virta:task': TASK })
    expect(configs.map((c) => c.name)).toEqual(['virta:task'])
  })

  test('a library named "system" cannot declare the platform"s system:* (M2)', () => {
    // system:claim, system:host and system:seq are safe only because nothing
    // registers them. A manifest that did would reopen the claim ceremony,
    // mark a consumer's host a sandbox, or rewind a sequence.
    for (const key of ['system:claim', 'system:host', 'system:seq', 'system:registry']) {
      expect(planted({ [key]: TASK }, 'system')).toEqual([])
    }
  })

  test('a planted system:* key is DROPPED from the merge, not just outranked', () => {
    // A batch merges the maps of every collection it touches, so a key that
    // survived here would ride along with any legitimate write.
    const merged = mergePlatformLast({
      'system:claim': { schema: {}, access: { public: { write: ALL } } } as never,
      'virta:task': { schema: {}, access: {} } as never,
    })
    expect('system:claim' in merged).toBe(false)
    expect(merged['virta:task']).toBeDefined()
  })

  test('and even if one slipped through, platform still wins the merge', () => {
    // Belt and braces. `refuseDeclaration` above is the real defence; this is
    // what happens if it ever has a hole.
    const hostile: CollectionMap = {
      role: { schema: {}, access: { public: { write: ALL } } } as never,
      'virta:task': { schema: {}, access: {} } as never,
    }
    const merged = mergePlatformLast(hostile)
    expect(merged.role).toBe(COLLECTIONS.role)
    expect(merged.role).not.toBe(hostile.role)
    // `role` is owner-only (D4) and stays that way.
    expect(getMethodAccess(merged, 'role', 'PUT', who([]))).toBeUndefined()
    // The library's own collection is untouched by the merge.
    expect(merged['virta:task']).toBe(hostile['virta:task'])
  })
})

describe('a broken install fails closed, and only for itself', () => {
  test('a grant whose manifest is missing contributes nothing', () => {
    const problems: string[] = []
    const configs = configsFromInstalled(
      [
        { grant: grant({ name: 'gone' }), manifest: null },
        { grant: grant(), manifest: manifest({ 'virta:task': TASK }) },
      ],
      (m) => problems.push(m)
    )
    expect(configs.map((c) => c.name)).toEqual(['virta:task'])
    expect(problems.join()).toContain('manifest is missing')
  })

  test('a PENDING grant stays live at its active version', () => {
    // A pending grant is a live install whose UPGRADE is parked waiting on a
    // human. Treating it as uninstalled means asking for one new capability
    // takes the library offline until somebody clicks approve — a safety
    // prompt that causes an outage teaches operators to approve without
    // reading. The query in `load()` is what enforces this; here we pin that
    // the shape carries no additional filter.
    const configs = configsFromInstalled([
      {
        grant: grant({ status: 'pending' }),
        manifest: manifest({ 'virta:task': TASK }),
      },
    ])
    expect(configs.map((c) => c.name)).toEqual(['virta:task'])
    expect(configs[0].version).toBe('1.0.0')
  })

  test('a grant with no active version contributes nothing', () => {
    // The shape a parked upgrade leaves behind on a first install that was
    // never approved: status is set, activeVersion is null.
    expect(
      configsFromInstalled([
        { grant: grant({ activeVersion: null }), manifest: manifest({ 'virta:task': TASK }) },
      ])
    ).toEqual([])
  })
})

describe('the platform hot path is untouched', () => {
  test('a bare name returns COLLECTIONS itself — same object, no read', async () => {
    // The whole safety argument for shipping this to a live blog. If this ever
    // returns a copy, every /doc request has started paying for a datastore
    // read and a compile, and D18's sequencing has silently been skipped.
    for (const name of ['post', 'page', 'role', 'config', 'post/comment']) {
      expect(await collectionsFor(name)).toBe(COLLECTIONS)
    }
  })

  test('a namespaced name does NOT return COLLECTIONS', async () => {
    // Guards against the short-circuit swallowing everything, which would make
    // the test above pass while installed collections silently never resolve.
    // (No Firebase here, so the registry load fails — and fails CLOSED, which
    // is itself the documented behaviour.)
    const map = await collectionsFor('virta:task')
    expect(map).not.toBe(COLLECTIONS)
    expect(map['virta:task']).toBeUndefined()
    // Platform collections survive a failed load, because they are compiled.
    expect(map.role).toBe(COLLECTIONS.role)
  })
})
