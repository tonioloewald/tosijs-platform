/**
 * The seeded DATA configs decide exactly what the shipped TYPESCRIPT decides —
 * including what their filter functions decide, not just that both have one.
 *
 * `seed-configs.test.ts` compares decisions by KIND ("ALL", "a filter", "deny")
 * and cannot load `post` or `page`, which are registered by endpoint modules
 * that initialise firebase-admin at import. Comparing kinds let a real drift
 * through: shipped `page` lists a page to the public only when it is tagged
 * `public` AND `visible`; the seed required only `public`, so the registry swap
 * (D19) would have listed unlisted pages to everyone. This file loads the real
 * modules with firebase-admin stubbed, and runs both filters over fixtures.
 */
import { describe, test, expect, mock } from 'bun:test'

// Stub BEFORE the endpoint modules load: they call initializeApp()/firestore()
// at import. Nothing here reaches a store — the filters are pure.
mock.module('firebase-admin', () => {
  const firestore: any = () => ({ collection: () => ({}), doc: () => ({}) })
  firestore.FieldValue = { increment: () => 0, serverTimestamp: () => 0 }
  return { initializeApp: () => undefined, firestore, auth: () => ({}), apps: [] }
})

const { COLLECTIONS } = await import('./index')
await import('../blog')
await import('../page')
const { PLATFORM_CONFIGS } = await import('./seed-configs')
const { compileStored } = await import('./registry')
const { ALL, getMethodAccess } = await import('./access')
const { ROLES } = await import('./roles')

const seeded = compileStored(PLATFORM_CONFIGS).collections
const METHODS = ['GET', 'LIST', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const EVERY_ROLE = Object.values(ROLES)
const who = (roles: string[]) =>
  ({ name: 'x', contacts: [], roles, userIds: ['uid'] }) as never

const FIXTURES: Record<string, Array<Record<string, unknown>>> = {
  post: [
    { title: 'published', content: 'x', path: 'a', date: '2026-01-01' },
    { title: 'unpublished, empty date', content: 'x', path: 'b', date: '' },
    { title: 'unpublished, whitespace date', content: 'x', path: 'c', date: '  ' },
    { title: 'no date field at all', content: 'x', path: 'd' },
  ],
  page: [
    { title: 't', description: 'd', path: 'p1', source: 's', tags: [] },
    { title: 't', description: 'd', path: 'p2', source: 's', tags: ['public'] },
    { title: 't', description: 'd', path: 'p3', source: 's', tags: ['visible'] },
    { title: 't', description: 'd', path: 'p4', source: 's', tags: ['public', 'visible'] },
  ],
}

/** What a decision does to a document: allowed, denied, or which fields survive. */
const outcome = async (decision: unknown, doc: Record<string, unknown>) => {
  if (decision === undefined) return 'deny'
  if (decision === ALL) return 'all'
  if (typeof decision === 'function') {
    const r = await (decision as (d: unknown) => unknown)(structuredClone(doc))
    if (r instanceof Error) return 'hidden'
    return `shown:${Object.keys(r as object).sort().join(',')}`
  }
  return `other:${typeof decision}`
}

for (const name of Object.keys(FIXTURES)) {
  describe(`${name}: the data config decides what the TypeScript decides`, () => {
    test('every role × method × fixture', async () => {
      const mismatches: string[] = []
      for (const role of EVERY_ROLE) {
        for (const method of METHODS) {
          const fromCode = getMethodAccess(COLLECTIONS, name, method, who([role]))
          const fromData = getMethodAccess(seeded, name, method, who([role]))
          for (const doc of FIXTURES[name]) {
            const a = await outcome(fromCode, doc)
            const b = await outcome(fromData, doc)
            if (a !== b) {
              mismatches.push(`${role} ${method} "${String(doc.path)}": code=${a} data=${b}`)
            }
          }
        }
      }
      expect(mismatches).toEqual([])
    })

    test('unique and tagFields match', () => {
      const sort = (a?: string[]) => [...(a ?? [])].sort()
      expect(sort(seeded[name]?.unique)).toEqual(sort(COLLECTIONS[name]?.unique))
      expect(sort(seeded[name]?.tagFields)).toEqual(sort(COLLECTIONS[name]?.tagFields))
    })
  })
}

test('the comparison exercises real filters, not deny-vs-deny', async () => {
  // Guards against the loop passing because both sides deny everything.
  const list = getMethodAccess(seeded, 'page', 'LIST', who([ROLES.public]))
  expect(typeof list).toBe('function')
  expect(await outcome(list, FIXTURES.page[3])).toStartWith('shown')
})
