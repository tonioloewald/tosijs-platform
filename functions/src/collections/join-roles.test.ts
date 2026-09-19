/**
 * Joining role documents (B1, #6).
 *
 * "Who is this principal" is the input to every access decision in the system,
 * so a wrong answer here is wrong everywhere at once. The specific defect: the
 * old code fetched `limit 2` role documents and used `roles[0]`.
 *
 * Run: cd functions && bun test src/collections/join-roles.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import { joinRoleDocs, MAX_ROLE_DOCS, type RoleRecord } from './join-roles'
import { anonymousUser, ROLES } from './roles'

const doc = (over: Partial<RoleRecord> = {}): RoleRecord => ({
  _id: 'r1',
  name: 'Someone',
  roles: [ROLES.author],
  userIds: ['uid-1'],
  contacts: [{ type: 'email', value: 'a@example.com' }],
  ...over,
})

describe('no documents means no authority', () => {
  test('it returns the shared anonymous identity', () => {
    // Identity matters: getUserRoles compares against `anonymousUser` by
    // reference to decide whether to sync custom claims.
    expect(joinRoleDocs([])).toBe(anonymousUser)
  })

  test('anonymous has no roles at all', () => {
    expect(joinRoleDocs([]).roles).toEqual([])
  })
})

describe('several documents JOIN rather than compete', () => {
  const docs = [
    doc({ _id: 'r1', roles: [ROLES.author] }),
    doc({
      _id: 'r2',
      roles: [ROLES.admin],
      userIds: ['uid-2'],
      contacts: [{ type: 'email', value: 'b@example.com' }],
    }),
  ]

  test('roles are unioned, not picked', () => {
    // The defect this replaces: `roles[0]` returned whichever document
    // `_created desc` happened to order first, so an unrelated edit to either
    // document silently changed what this principal could do.
    expect(joinRoleDocs(docs).roles.sort()).toEqual(
      [ROLES.admin, ROLES.author].sort()
    )
  })

  test('the join is order-independent', () => {
    const forward = joinRoleDocs(docs).roles.sort()
    const backward = joinRoleDocs([...docs].reverse()).roles.sort()
    expect(forward).toEqual(backward)
  })

  test('userIds and contacts come along', () => {
    const joined = joinRoleDocs(docs)
    expect(joined.userIds.sort()).toEqual(['uid-1', 'uid-2'])
    expect(joined.contacts.map((c) => c.value).sort()).toEqual([
      'a@example.com',
      'b@example.com',
    ])
  })

  test('a duplicate role or contact appears once', () => {
    const joined = joinRoleDocs([doc({ _id: 'r1' }), doc({ _id: 'r2' })])
    expect(joined.roles).toEqual([ROLES.author])
    expect(joined.contacts).toHaveLength(1)
    expect(joined.userIds).toEqual(['uid-1'])
  })

  test('joining more than one is reported', () => {
    // Not an error — an owner may legitimately grant twice — but a principal
    // assembling authority from many documents is worth seeing in a log.
    const warnings: string[] = []
    joinRoleDocs(docs, (m) => warnings.push(m))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('r1')
    expect(warnings[0]).toContain('r2')
  })

  test('a single document is not reported', () => {
    const warnings: string[] = []
    joinRoleDocs([doc()], (m) => warnings.push(m))
    expect(warnings).toEqual([])
  })
})

describe('missing fields never become authority', () => {
  test('a document with no roles contributes none', () => {
    expect(joinRoleDocs([doc({ roles: undefined })]).roles).toEqual([])
  })

  test('an empty document is still a principal, just a powerless one', () => {
    const joined = joinRoleDocs([{}])
    expect(joined).not.toBe(anonymousUser)
    expect(joined.roles).toEqual([])
    expect(joined.name).toBe('unknown')
  })

  test('missing contacts/userIds do not throw', () => {
    const joined = joinRoleDocs([{ _id: 'x', roles: [ROLES.owner] }])
    expect(joined.roles).toEqual([ROLES.owner])
    expect(joined.contacts).toEqual([])
    expect(joined.userIds).toEqual([])
  })
})

describe('the bound is a bound', () => {
  test('MAX_ROLE_DOCS caps accumulated authority, and is small', () => {
    // It is not a page size — every fetched document is joined. If it ever
    // grows into the hundreds it has stopped being a safety limit.
    expect(MAX_ROLE_DOCS).toBeGreaterThan(1)
    expect(MAX_ROLE_DOCS).toBeLessThanOrEqual(25)
  })
})
