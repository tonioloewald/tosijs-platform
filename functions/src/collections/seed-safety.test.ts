/**
 * The seed must not hand out authority (tosijs-platform#23, found by audit).
 *
 * `initial_state/firestore/role.json` seeded four role documents keyed on
 * REAL Gmail addresses, one of them granting
 * `["owner","developer","admin","editor","author"]`.
 *
 * `getUserRoles` resolves a principal by matching `contacts` on email. So
 * anyone controlling `owner@gmail.com` — an address registered to somebody,
 * years ago — could sign in with Google to any host seeded from this repo and
 * be `owner`, which per D4 means rewriting the input to everyone's
 * authorization. Found on a consumer's host, where it was live.
 *
 * Making the email lookup indexed and reliable (B1, #6) made this vector MORE
 * reliable, not less. A fixture is not a test fixture once it is deployed.
 *
 * Run: cd functions && bun test src/collections/seed-safety.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

interface SeedRole {
  _id?: string
  roles?: string[]
  contacts?: Array<{ type: string; value: string }>
  userIds?: string[]
}

const seeded = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', 'initial_state', 'firestore', 'role.json'),
    'utf-8'
  )
) as SeedRole[]

describe('seeded role documents grant nothing', () => {
  test('there is something to check', () => {
    expect(seeded.length).toBeGreaterThan(0)
  })

  for (const doc of seeded) {
    test(`${doc._id}: no roles`, () => {
      // A seed that grants is a seed that grants on every host it touches,
      // including somebody else's.
      expect(doc.roles ?? []).toEqual([])
    })

    test(`${doc._id}: no uid grant`, () => {
      expect(doc.userIds ?? []).toEqual([])
    })

    test(`${doc._id}: its email cannot be registered by anyone`, () => {
      // RFC 2606 reserves `.invalid` and `.example`; `.test` too. A seeded
      // contact on a REGISTERABLE domain is a standing invitation, because
      // role resolution matches on it.
      for (const contact of doc.contacts ?? []) {
        if (contact.type !== 'email') continue
        expect(contact.value).toMatch(/@[a-z0-9.-]*\.(invalid|example|test)$/)
      }
    })
  }
})
