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
const { PLATFORM_HOOKS } = await import('./hooks')

const seeded = compileStored(PLATFORM_CONFIGS).collections
const METHODS = ['GET', 'LIST', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const EVERY_ROLE = Object.values(ROLES)
const who = (roles: string[]) =>
  ({ name: 'x', contacts: [], roles, userIds: ['uid'] }) as never

await import('./module')
await import('./config')
await import('./role')
const { validate: schemaValidate } = await import('tosijs-schema')

const FIXTURES: Record<string, Array<Record<string, unknown>>> = {
  module: [
    { name: 'm1', source: 'export {}', version: '1.0.0', tags: [] },
    { name: 'm2', source: 'export {}', version: '1.0.0', tags: ['public'] },
    { name: 'm3', source: 'export {}', version: '1.0.0', tags: ['public', 'visible'] },
    { name: 'm4', source: 'export {}', version: '1.0.0' },
  ],
  config: [{ name: 'app', host: 'example.org' }, { name: 'blog' }],
  role: [{ name: 'r', roles: ['author'], userIds: ['u'], contacts: [] }],
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
    let r: unknown
    try {
      r = await (decision as (d: unknown) => unknown)(structuredClone(doc))
    } catch {
      // The compiled module/page filters dereference `tags` and THROW on a
      // document without it (a 500); the data rule hides it. See ACCEPTED.
      return 'throws'
    }
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
            // ACCEPTED divergence: where compiled code crashes, data hides.
            // Hiding is the deny-by-default answer; a crash was never a
            // decision anyone made.
            if (a === 'throws' && b === 'hidden') continue
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

test('every compiled afterWrite is registered as a platform hook (D19)', () => {
  // Data configs cannot carry code, so a side effect the compiled config runs
  // after a write must be attached by name on the registry path — or the swap
  // silently drops it (for `post`: stale pages for up to a day).
  const withHook = Object.entries(COLLECTIONS).filter(([, c]) => c.afterWrite)
  expect(withHook.length).toBeGreaterThan(0)
  for (const [name, config] of withHook) {
    expect(PLATFORM_HOOKS[name]?.afterWrite).toBe(config.afterWrite)
  }
})

// --- schema parity ------------------------------------------------------------
// Access parity says who may write; this says WHAT they may write. The
// seeded schema is JSON Schema, the compiled one tosijs-schema — the same
// documents must be accepted and refused by both.
const SCHEMA_FIXTURES: Record<string, Array<Record<string, unknown>>> = {
  post: [
    { title: 't', content: 'c' },
    { title: 't' },
    { content: 'c' },
    { title: 't', content: 'c', keywords: ['a'] },
    { title: 't', content: 'c', keywords: 'a' },
    { title: 1, content: 'c' },
  ],
  page: [
    { title: 't', description: 'd', path: 'p', source: 's' },
    { title: 't', description: 'd', path: 'p' },
    { title: 't', description: 'd', path: 'p', source: 's', tags: ['x'] },
    { title: 't', description: 'd', path: 'p', source: 's', tags: 'x' },
  ],
  module: [
    { name: 'm', source: 's', version: '1.0.0' },
    { name: 'm', source: 's', version: 'not-semver' },
    { name: 'm', source: 's' },
    { name: 'm', source: 's', version: '1.0.0', revisions: 2 },
    { name: 'm', source: 's', version: '1.0.0', revisions: 1.5 },
    { name: 'm', source: 's', version: '1.0.0', tags: ['x'] },
  ],
}

for (const name of Object.keys(SCHEMA_FIXTURES)) {
  test(`${name}: the seeded schema accepts and refuses what the compiled one does`, () => {
    const mismatches: string[] = []
    for (const doc of SCHEMA_FIXTURES[name]) {
      const a = schemaValidate(doc, COLLECTIONS[name].schema as never, { strict: true } as never)
      const b = schemaValidate(doc, seeded[name].schema as never, { strict: true } as never)
      if (a !== b) mismatches.push(`${JSON.stringify(doc)}: code=${a} data=${b}`)
    }
    expect(mismatches).toEqual([])
  })
}

test('post: saving a LEGACY path leaves it exactly as stored — code and data (B1)', async () => {
  // 96 of 791 production paths are not what slugify would produce (trailing
  // `-`, `_`, over 80 characters). An edit must not move them.
  const legacy = ['what-s-in-a-name-', 'x'.repeat(86), 'under_score', 'Mixed-Case']
  for (const path of legacy) {
    const body = () => ({ title: 'Some Title', content: 'c', path })
    const codeValidate = COLLECTIONS.post.validate
    const dataValidate = seeded.post.validate
    if (!codeValidate || !dataValidate) throw new Error('post has no validate on one side')
    const fromCode = await codeValidate(body(), who([ROLES.author]), { path })
    const fromData = await dataValidate(body(), who([ROLES.author]), { path })
    expect((fromCode as { path: string }).path).toBe(path)
    expect((fromData as { path: string }).path).toBe(path)
  }
})
