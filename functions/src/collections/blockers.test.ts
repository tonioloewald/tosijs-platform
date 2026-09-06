/**
 * Regression tests for the three blockers from the 2026-09-06 pre-release review
 * (`reviews/2026-09-06-backend-consolidation.md`).
 *
 * B2 and B3 are backend and covered here. B1 is client-side (`src/blog.ts`) and
 * has no test harness in this package — tracked as F11.
 *
 * Run: cd functions && bun test src/collections/blockers.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { COLLECTIONS } from './index'
import { accessMap, getMethodAccess, ALL } from './access'
import type { UserRoles } from './roles'
import { ROLES } from './roles'

const anonymous: UserRoles = {
  name: 'anon',
  contacts: [],
  roles: [ROLES.public],
  userIds: [],
} as unknown as UserRoles

// ── B3 — the demo collection must not exist in a deployed function ──────────
describe('B3: the demo `test` collection is emulator-only', () => {
  test('it is NOT registered when FUNCTIONS_EMULATOR is unset (i.e. deployed)', () => {
    // This suite runs without FUNCTIONS_EMULATOR, which is the deployed shape.
    expect(process.env.FUNCTIONS_EMULATOR).not.toBe('true')
    expect(COLLECTIONS.test).toBeUndefined()
  })

  test('an anonymous caller gets no write access to it', () => {
    // Deny-by-default: an unregistered collection has no config, so every method
    // resolves to undefined regardless of the role.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(
        getMethodAccess(COLLECTIONS, 'test', method, anonymous, false)
      ).toBeUndefined()
    }
  })

  test('an anonymous caller cannot list it either', () => {
    expect(
      getMethodAccess(COLLECTIONS, 'test', 'LIST', anonymous, false)
    ).toBeUndefined()
  })

  test('DELETE really does resolve through the write permission', () => {
    // The reason `write: ALL` was a delete grant, pinned so the mapping cannot
    // drift back without notice.
    expect(accessMap.DELETE).toBe('write')
  })

  test('no registered collection grants the public role write access', () => {
    // The general form of B3 — catches the next demo fixture someone adds.
    for (const [name, config] of Object.entries(COLLECTIONS)) {
      const write = config.access?.[ROLES.public]?.write
      expect(write ?? undefined, `${name} grants public write`).toBeUndefined()
    }
  })

  test('no registered collection grants the public role list: ALL', () => {
    for (const [name, config] of Object.entries(COLLECTIONS)) {
      const list = config.access?.[ROLES.public]?.list
      // A filter function is fine (it strains rows); blanket ALL is what leaks.
      expect(list === ALL, `${name} grants public list: ALL`).toBe(false)
    }
  })
})

// ── B2 — afterWrite must fire on DELETE as well as write ───────────────────
//
// doc.ts is an onRequest handler bound to Firestore, so it cannot be imported
// and driven here (tracked as F2: the endpoint has no unit harness). Until that
// extraction lands, assert the wiring at the source level — crude, but it fails
// if the DELETE call site is removed, which is exactly the regression that
// shipped and which a helper-level test could not see.
describe('B2: afterWrite is wired into DELETE, not just write', () => {
  const source = readFileSync(join(__dirname, '..', 'doc.ts'), 'utf-8')

  test('doc.ts has more than one afterWrite call site', () => {
    const callSites = source.match(/config\.afterWrite\(/g) ?? []
    expect(callSites.length).toBeGreaterThanOrEqual(2)
  })

  test('the DELETE branch invokes afterWrite after ref.delete()', () => {
    const deleteBranch = source.slice(
      source.indexOf("case 'DELETE':"),
      source.indexOf("case 'POST':")
    )
    expect(deleteBranch).toContain('ref.delete()')
    expect(deleteBranch).toContain('config.afterWrite(')
    // ordering: invalidate AFTER the delete lands, same rule as the write path
    expect(deleteBranch.indexOf('ref.delete()')).toBeLessThan(
      deleteBranch.indexOf('config.afterWrite(')
    )
  })

  test('afterWrite failures are swallowed on the delete path too', () => {
    const deleteBranch = source.slice(
      source.indexOf("case 'DELETE':"),
      source.indexOf("case 'POST':")
    )
    expect(deleteBranch).toContain('afterWrite failed')
  })
})
