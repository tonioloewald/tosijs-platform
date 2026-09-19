/**
 * Every composite-index-requiring query must be declared in
 * `firestore.indexes.json`.
 *
 * ## Why this exists
 *
 * `getUserRoles`'s fast path (`utilities.ts`) runs
 *
 *   getRecords('role', 'userIds', 'array-contains', uid, 2)
 *
 * and `getRecords` unconditionally appends `orderBy('_created', 'desc')`.
 * Firestore requires a COMPOSITE INDEX for `array-contains` combined with an
 * order on a different field; without one the query throws FAILED_PRECONDITION,
 * and `getUserRoles` has no try/catch, so `/doc` would 500 for every signed-in
 * user.
 *
 * Production has that index — but it was created through the console and was
 * never added to `firestore.indexes.json`, which was `{"indexes": []}`. The
 * result was invisible drift: production worked, source control did not
 * describe it, and **a project provisioned from this repo had zero indexes**.
 * Confirmed 2026-09-17 against the new sandbox, which would have failed on the
 * first sign-in in a way production never does.
 *
 * The emulator does not enforce composite indexes, so no integration test can
 * catch this either — a green suite is not evidence. Hence a source-level test.
 *
 * ## What would break this test
 *
 * Adding another `array-contains` (or range/inequality) query with an ordering,
 * and not declaring its index. That is the whole point: the next one should be
 * caught here rather than on a fresh deploy.
 *
 * Run: cd functions && bun test src/collections/indexes.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const repoRoot = join(__dirname, '..', '..', '..')
const indexes = JSON.parse(
  readFileSync(join(repoRoot, 'firestore.indexes.json'), 'utf-8')
) as {
  indexes: Array<{
    collectionGroup: string
    fields: Array<{ fieldPath: string; arrayConfig?: string; order?: string }>
  }>
}
const utilities = readFileSync(
  join(__dirname, '..', 'utilities.ts'),
  'utf-8'
)

const hasIndex = (
  collection: string,
  arrayField: string,
  orderField: string
): boolean =>
  indexes.indexes.some(
    (i) =>
      i.collectionGroup === collection &&
      i.fields.some(
        (f) => f.fieldPath === arrayField && f.arrayConfig === 'CONTAINS'
      ) &&
      i.fields.some((f) => f.fieldPath === orderField && f.order)
  )

describe('firestore.indexes.json covers the queries the code actually makes', () => {
  test('getRecords still appends an orderBy — the reason an index is needed', () => {
    // If this stops being true the requirement may have gone away; check before
    // deleting the index declaration.
    expect(utilities).toMatch(/orderBy\s*=\s*['"]_created desc['"]/)
    expect(utilities).toMatch(/ref\.orderBy\(/)
  })

  test('getUserRoles still uses array-contains on role.userIds', () => {
    expect(utilities).toMatch(/'role',\s*\n?\s*'userIds',\s*\n?\s*'array-contains'/)
  })

  test('role: userIds array-contains + _created order IS declared', () => {
    // The index production has, and the sandbox did not.
    expect(hasIndex('role', 'userIds', '_created')).toBe(true)
  })

  test('getUserRoles also queries role.contacts by array-contains', () => {
    // The email fallback stopped being a 100-document client-side scan on
    // 2026-09-19. The query it became needs its own composite index — and
    // this is the ONE path a brand-new user hits on first sign-in, so getting
    // it wrong means a fresh host works for nobody.
    expect(utilities).toMatch(
      /'role',\s*\n?\s*'contacts',\s*\n?\s*'array-contains'/
    )
  })

  test('role: contacts array-contains + _created order IS declared', () => {
    expect(hasIndex('role', 'contacts', '_created')).toBe(true)
  })

  test('the scan it replaced is gone', () => {
    // `getRecords('role', undefined, undefined, undefined, 100)` — an
    // unfiltered fetch of the 100 newest role docs, matched in memory.
    expect(utilities).not.toMatch(
      /getRecords<RoleDoc>\(\s*'role',\s*undefined/
    )
  })

  test('the file is not the empty stub it used to be', () => {
    expect(indexes.indexes.length).toBeGreaterThan(0)
  })
})
