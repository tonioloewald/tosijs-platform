/**
 * The seeded platform configs must be valid, and must match the TypeScript they
 * replace (#5).
 *
 * This is the pre-flight for switching `/doc` onto the registry. Where the
 * shipped config is importable without Firebase (`module`, `role`, `config`,
 * and the install records) it is compared DIRECTLY against the live object.
 * `post` and `page` live in `blog.ts`/`page.ts`, which call
 * `admin.initializeApp()` at module scope, so they are covered behaviourally in
 * `install/equivalence.test.ts` instead.
 *
 * Run: cd functions && bun test src/collections/seed-configs.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { unenforcedKeywords } from 'tosijs-schema'

import { PLATFORM_CONFIGS } from './seed-configs'
import { compileStored } from './registry'
import { ALL, getMethodAccess, type REST_METHOD } from './access'
import { ROLES, type UserRoles, type RoleName } from './roles'
import { COLLECTIONS } from './index'
import './module'
import './config'
import './role'
import './install-records'
import './token-records'
import { readFileSync } from 'fs'
import { join } from 'path'
import { validateManifest } from '../install/manifest'

const who = (roles: string[]): UserRoles => ({
  name: 'x',
  contacts: [],
  roles: roles as RoleName[],
  userIds: ['uid'],
})

const METHODS: REST_METHOD[] = ['GET', 'LIST', 'POST', 'PUT', 'PATCH', 'DELETE']
const EVERY_ROLE = Object.values(ROLES)

const { collections: seeded, failed } = compileStored(PLATFORM_CONFIGS)

describe('every seeded config is usable', () => {
  test('all nine compile', () => {
    expect(failed).toEqual([])
    expect(Object.keys(seeded).sort()).toEqual(
      PLATFORM_CONFIGS.map((c) => c.name).sort()
    )
  })

  test('their schemas would survive the manifest validator', () => {
    // The same gate a third-party manifest faces — no `$predicate`, no
    // keywords the validator silently ignores. If the platform's own configs
    // cannot pass it, the gate is wrong or the configs are.
    const problems = validateManifest(
      {
        manifest: 1,
        name: 'platform',
        version: '1.0.0',
        collections: Object.fromEntries(
          PLATFORM_CONFIGS.filter((c) => !c.name.includes('/')).map((c) => [
            `platform:${c.name}`,
            c.collection,
          ])
        ),
      },
      {
        unenforced: (s) => unenforcedKeywords(s as never) as string[],
        knownRoles: EVERY_ROLE,
      }
    )
    expect(problems.map((p) => p.message)).toEqual([])
  })
})

/**
 * Compare the data form against the SHIPPED object, for every collection that
 * can be imported without Firebase. The comparison is on decisions, not on
 * structure: compiled predicates are distinct function objects by construction,
 * so what has to match is what the access engine concludes.
 */
describe('decisions match the shipped TypeScript', () => {
  const comparable = ['module', 'config', 'role', 'manifest', 'grant', 'install-log']
  const kind = (d: unknown) =>
    d === ALL ? 'ALL' : typeof d === 'function' ? 'fn' : 'deny'

  for (const name of comparable) {
    test(`${name}: identical for every role × method`, () => {
      const mismatches: string[] = []
      for (const role of EVERY_ROLE) {
        for (const method of METHODS) {
          const fromCode = getMethodAccess(COLLECTIONS, name, method, who([role]))
          const fromData = getMethodAccess(seeded, name, method, who([role]))
          if (kind(fromCode) !== kind(fromData)) {
            mismatches.push(
              `${name} ${role} ${method}: code=${kind(fromCode)} data=${kind(fromData)}`
            )
          }
        }
      }
      expect(mismatches).toEqual([])
    })
  }

  test('the comparison is actually exercising something', () => {
    // Guards against every lookup being `deny` on both sides, which would make
    // the loop above pass while proving nothing.
    const granted = EVERY_ROLE.flatMap((role) =>
      METHODS.map((m) => getMethodAccess(seeded, 'module', m, who([role])))
    ).filter((d) => d !== undefined)
    expect(granted.length).toBeGreaterThan(3)
  })
})

describe('the rules that must not drift', () => {
  test('role is OWNER-ONLY — the D4 escalation chain stays severed', () => {
    for (const role of EVERY_ROLE) {
      for (const method of METHODS) {
        const access = getMethodAccess(seeded, 'role', method, who([role]))
        if (role === ROLES.owner) expect(access).toBe(ALL)
        else expect(access).toBeUndefined()
      }
    }
  })

  test('install records reject every write, for every role', () => {
    for (const name of ['manifest', 'grant', 'install-log']) {
      for (const role of EVERY_ROLE) {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as REST_METHOD[]) {
          expect(getMethodAccess(seeded, name, method, who([role]))).toBeUndefined()
        }
      }
    }
  })

  test('a draft is readable by link but never listed', async () => {
    // Deliberate: unpublished posts are unlisted, not secret.
    expect(getMethodAccess(seeded, 'post', 'GET', who([]))).toBe(ALL)
    const list = getMethodAccess(seeded, 'post', 'LIST', who([])) as (
      r: unknown
    ) => Promise<unknown>
    expect(await list({ title: 'draft', date: '' })).toBeInstanceOf(Error)
    expect(await list({ title: 'live', date: '2026-01-01' })).toMatchObject({
      title: 'live',
    })
  })

  test('the public cannot write anything, anywhere', () => {
    const writes: string[] = []
    for (const name of Object.keys(seeded)) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as REST_METHOD[]) {
        if (getMethodAccess(seeded, name, method, who([])) !== undefined) {
          writes.push(`${name} ${method}`)
        }
      }
    }
    expect(writes).toEqual([])
  })
})

describe('uniqueness matches the shipped TypeScript (D19)', () => {
  // `post` makes title AND path unique, each on its own. The seed used to carry
  // only `path`, because manifest v1 refused several fields — so the swap would
  // have silently allowed duplicate titles.
  for (const entry of PLATFORM_CONFIGS) {
    const shipped = COLLECTIONS[entry.name]
    if (!shipped) continue // post/page live in endpoint modules; see below
    test(`${entry.name}: unique is ${JSON.stringify(shipped.unique ?? [])}`, () => {
      expect([...(seeded[entry.name]?.unique ?? [])].sort()).toEqual(
        [...(shipped.unique ?? [])].sort()
      )
    })
  }

  test('post: title AND path, as blog.ts declares', () => {
    // blog.ts initialises firebase-admin at import, so it is read, not loaded.
    const blog = readFileSync(join(__dirname, '..', 'blog.ts'), 'utf-8')
    expect(blog).toContain("unique: ['title', 'path']")
    expect([...(seeded.post?.unique ?? [])].sort()).toEqual(['path', 'title'])
  })
})

describe('the seed names exactly the collections the code registers (B2)', () => {
  // A name in only one set is a decision that changes when the switch flips:
  // seeded-only OPENS a collection that is closed today (post/comment did),
  // compiled-only makes one inaccessible. Both must be deliberate.
  //
  // Compiled but deliberately NOT seeded:
  //   - `token`: `access: {}` compiled, so deny either way — written only by
  //     the /token endpoint, never through /doc.
  // `post`/`page` are registered by endpoint modules this file cannot load;
  // seed-parity.isolated.ts covers them.
  const NOT_SEEDED = new Set(['token'])
  const ENDPOINT_MODULES = new Set(['post', 'page'])

  test('every seeded name is compiled (or an endpoint-module collection)', () => {
    for (const { name } of PLATFORM_CONFIGS) {
      expect(COLLECTIONS[name] !== undefined || ENDPOINT_MODULES.has(name)).toBe(true)
    }
  })

  test('every compiled name is seeded (or deliberately not)', () => {
    const seededNames = new Set(PLATFORM_CONFIGS.map((c) => c.name))
    const missing = Object.keys(COLLECTIONS).filter(
      (n) => !seededNames.has(n) && !NOT_SEEDED.has(n) && n !== 'test'
    )
    expect(missing).toEqual([])
  })
})
