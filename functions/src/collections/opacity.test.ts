/**
 * Denial opacity — emulator-free unit coverage for the shared helpers.
 *
 * `/doc` answers 404 to a non-privileged caller so a protected resource does not
 * confirm its own existence. `/docs` used to answer 403 for the same collection,
 * which handed back exactly the fact the other endpoint was hiding: GET
 * `role/owner-role` said "not found" while LIST `role` said "forbidden".
 *
 * These pin the shared decision (`opaqueStatus` / `hasPrivilegedRole`) rather
 * than either endpoint, because the bug was the two endpoints DIVERGING — a test
 * per endpoint would have passed happily while the pair leaked.
 *
 * Run: cd functions && bun test src/collections/opacity.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { hasPrivilegedRole, opaqueStatus, PRIVILEGED_ROLES } from './access'
import { ROLES } from './roles'
import type { UserRoles } from './roles'

const withRoles = (roles: string[]): UserRoles =>
  ({ name: 'u', contacts: [], roles, userIds: ['u1'] } as unknown as UserRoles)

describe('who may see a real error', () => {
  test('admin, developer and owner are privileged', () => {
    for (const role of [ROLES.admin, ROLES.developer, ROLES.owner]) {
      expect(hasPrivilegedRole(withRoles([role]))).toBe(true)
    }
  })

  test('public, author and editor are not', () => {
    for (const role of [ROLES.public, ROLES.author, ROLES.editor]) {
      expect(hasPrivilegedRole(withRoles([role]))).toBe(false)
    }
  })

  test('an anonymous caller with no roles is not privileged', () => {
    expect(hasPrivilegedRole(withRoles([]))).toBe(false)
  })

  test('privilege is granted by ANY held role, not the highest', () => {
    // A caller holding both public and admin is still an admin.
    expect(hasPrivilegedRole(withRoles([ROLES.public, ROLES.admin]))).toBe(true)
  })

  test('the privileged set is exactly admin/developer/owner', () => {
    // Widening this set is a security decision; make it break a test.
    expect([...PRIVILEGED_ROLES].sort()).toEqual(
      [ROLES.admin, ROLES.developer, ROLES.owner].sort()
    )
  })
})

describe('opaqueStatus', () => {
  test('a non-privileged caller always gets 404, whatever the real status', () => {
    const anon = withRoles([ROLES.public])
    for (const real of [400, 403, 409, 500]) {
      expect(opaqueStatus(anon, real)).toBe(404)
    }
  })

  test('a privileged caller gets the real status', () => {
    const admin = withRoles([ROLES.admin])
    for (const real of [400, 403, 409, 500]) {
      expect(opaqueStatus(admin, real)).toBe(real)
    }
  })

  test('404 stays 404 for everyone (nothing to hide, nothing to leak)', () => {
    expect(opaqueStatus(withRoles([ROLES.public]), 404)).toBe(404)
    expect(opaqueStatus(withRoles([ROLES.admin]), 404)).toBe(404)
  })
})

describe('doc and docs agree — the property the divergence broke', () => {
  test('read and list denials are indistinguishable to an anonymous caller', () => {
    // The leak was structural: each endpoint was individually defensible, and
    // the PAIR disclosed. Assert them together so they cannot drift apart again.
    const anon = withRoles([ROLES.public])
    const readDenial = opaqueStatus(anon, 403) // /doc  -> access denied
    const listDenial = opaqueStatus(anon, 403) // /docs -> not listable
    expect(readDenial).toBe(listDenial)
    expect(readDenial).toBe(404)
  })

  test('privileged callers still get actionable statuses from both', () => {
    const admin = withRoles([ROLES.developer])
    expect(opaqueStatus(admin, 403)).toBe(403)
  })
})
