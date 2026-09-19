/**
 * The install records are WRITE-PROOF through `/doc` (A3, #5).
 *
 * These three collections describe a host's entire trust surface: which
 * libraries are installed, what each may do, and what happened. If any of them
 * were writable through the ordinary document endpoint, the install system's
 * guarantees would be forgeable by whoever holds that write — a `configurator`
 * could award themselves a capability they were never granted, a `developer`
 * could change what an approved manifest means after approval.
 *
 * "Authority to install is not authority to execute" (D13) only holds if there
 * is no ordinary path to these records. Asserted rather than assumed, and
 * asserted for EVERY role including owner, because the protection is structural
 * (no `write` entry => getMethodAccess returns undefined) and a single
 * well-meaning addition would undo it silently.
 *
 * Run: cd functions && bun test src/collections/install-records.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import { COLLECTIONS } from './index'
import './install-records'
import { getMethodAccess, type REST_METHOD } from './access'
import { ROLES, type UserRoles, type RoleName } from './roles'

const INSTALL_COLLECTIONS = ['manifest', 'grant', 'install-log']
const WRITE_METHODS: REST_METHOD[] = ['POST', 'PUT', 'PATCH', 'DELETE']
const EVERY_ROLE = Object.values(ROLES)

const who = (roles: string[]): UserRoles => ({
  name: 'x',
  contacts: [],
  roles: roles as RoleName[],
  userIds: ['uid'],
})

describe('no principal can write an install record through /doc', () => {
  for (const collection of INSTALL_COLLECTIONS) {
    test(`${collection}: every role × every write method is denied`, () => {
      const denied: string[] = []
      for (const role of EVERY_ROLE) {
        for (const method of WRITE_METHODS) {
          const access = getMethodAccess(
            COLLECTIONS,
            collection,
            method,
            who([role])
          )
          if (access !== undefined) denied.push(`${role} ${method}`)
        }
      }
      expect(denied).toEqual([])
    })
  }

  test('holding EVERY role at once still cannot write', () => {
    // The lattice joins grants, so a principal with every role gets the most
    // permissive answer available. If that is still `undefined`, no combination
    // of roles can write.
    const superuser = who(EVERY_ROLE)
    for (const collection of INSTALL_COLLECTIONS) {
      for (const method of WRITE_METHODS) {
        expect(
          getMethodAccess(COLLECTIONS, collection, method, superuser)
        ).toBeUndefined()
      }
    }
  })

  test('the configs declare no `write` key at all', () => {
    // Belt and braces: the denial above follows from the ABSENCE of `write`.
    // Adding `write` with a field map would ALSO deny today (F1 fails closed),
    // which would make the test above pass for a different and much more
    // fragile reason. Assert the structure, not just the outcome.
    for (const collection of INSTALL_COLLECTIONS) {
      const access = COLLECTIONS[collection]?.access ?? {}
      for (const [, config] of Object.entries(access)) {
        expect((config as Record<string, unknown>).write).toBeUndefined()
      }
    }
  })
})

describe('install records are readable by those who act on them', () => {
  test('configurator and owner can read and list', () => {
    for (const collection of INSTALL_COLLECTIONS) {
      for (const role of [ROLES.configurator, ROLES.owner]) {
        expect(
          getMethodAccess(COLLECTIONS, collection, 'GET', who([role]))
        ).toBeDefined()
        expect(
          getMethodAccess(COLLECTIONS, collection, 'LIST', who([role]))
        ).toBeDefined()
      }
    }
  })

  test('the public cannot read them — a manifest is a map of the host', () => {
    for (const collection of INSTALL_COLLECTIONS) {
      expect(
        getMethodAccess(COLLECTIONS, collection, 'GET', who([ROLES.public]))
      ).toBeUndefined()
      expect(
        getMethodAccess(COLLECTIONS, collection, 'LIST', who([ROLES.public]))
      ).toBeUndefined()
    }
  })

  test('a developer cannot read them either', () => {
    // `developer` is powerful (it writes `module`, which /esm serves as
    // executable JS) but it is not part of the install trust surface.
    for (const collection of INSTALL_COLLECTIONS) {
      expect(
        getMethodAccess(COLLECTIONS, collection, 'LIST', who([ROLES.developer]))
      ).toBeUndefined()
    }
  })
})
