/**
 * Parity tests for the extracted write pipeline (ROADMAP Phase 1, rung 1).
 *
 * These are the "shadow mode" half of drop-in parity: they assert the pure
 * pipeline reproduces `doc.ts`'s inline write path decision-for-decision, using
 * the same oracle the existing characterization tests use (`validate.test.ts`,
 * `access.test.ts`, `write-path.integration.test.ts`) — but with NO emulator,
 * because the clock and the privileged read are injected.
 *
 * One deliberate divergence is pinned at the bottom: the §3 no-op check, which
 * `doc.ts` does not implement. It is called out as a behaviour change so the
 * cutover is a decision rather than a surprise.
 *
 * Run: cd functions && bun test src/collections/write-pipeline.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { s } from 'tosijs-schema'
import {
  runWritePipeline,
  isUnchanged,
  stripEnvelope,
  type WritePipelineDeps,
} from './write-pipeline'
import type { CollectionConfig } from './access'
import type { UserRoles } from './roles'

const NOW = '2026-09-05T12:00:00.000Z'
const EARLIER = '2020-01-01T00:00:00.000Z'

const deps = (over: Partial<WritePipelineDeps> = {}): WritePipelineDeps => ({
  now: () => NOW,
  isUnique: async () => true,
  ...over,
})

const roles: UserRoles = {
  name: 'tester',
  contacts: [],
  roles: ['admin'],
  userIds: ['u1'],
} as UserRoles

const bare: CollectionConfig = {}

describe('envelope handling (§5)', () => {
  test('strips endpoint-owned fields from the stored body', () => {
    expect(
      stripEnvelope({ _id: 'x', _collection: 'c', _path: 'c/x', title: 't' })
    ).toEqual({ title: 't' })
  })

  test('a create never persists envelope fields the caller sent', async () => {
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { _id: 'spoof', _collection: 'spoof', _path: 'spoof', title: 't' },
        existing: null,
        config: bare,
        userRoles: roles,
      },
      deps()
    )
    expect(out.status).toBe('write')
    if (out.status !== 'write') return
    expect(out.data._id).toBeUndefined()
    expect(out.data._collection).toBeUndefined()
    expect(out.data._path).toBeUndefined()
    expect(out.data.title).toBe('t')
  })
})

describe('existence guards (parity with doc.ts)', () => {
  test('POST onto an existing document is rejected', async () => {
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { title: 't' },
        existing: { title: 'old' },
        config: bare,
        userRoles: roles,
      },
      deps()
    )
    expect(out).toMatchObject({ status: 'rejected', reason: 'exists' })
  })

  test('PUT onto a missing document is rejected', async () => {
    const out = await runWritePipeline(
      {
        method: 'PUT',
        body: { title: 't' },
        existing: null,
        config: bare,
        userRoles: roles,
      },
      deps()
    )
    expect(out).toMatchObject({ status: 'rejected', reason: 'missing' })
  })

  test('an empty object counts as "does not exist" (doc.ts passes {} on create)', async () => {
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { title: 't' },
        existing: {},
        config: bare,
        userRoles: roles,
      },
      deps()
    )
    expect(out.status).toBe('write')
  })
})

describe('provenance stamping via the injected clock (§4.1)', () => {
  test('create stamps _created and _modified to now', async () => {
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { title: 't' },
        existing: null,
        config: bare,
        userRoles: roles,
      },
      deps()
    )
    if (out.status !== 'write') throw new Error('expected write')
    expect(out.data._created).toBe(NOW)
    expect(out.data._modified).toBe(NOW)
  })

  test('update preserves the original _created and advances _modified', async () => {
    const out = await runWritePipeline(
      {
        method: 'PUT',
        body: { title: 'new' },
        existing: { title: 'old', _created: EARLIER, _modified: EARLIER },
        config: bare,
        userRoles: roles,
      },
      deps()
    )
    if (out.status !== 'write') throw new Error('expected write')
    expect(out.data._created).toBe(EARLIER)
    expect(out.data._modified).toBe(NOW)
  })

  test('a caller cannot forge _created', async () => {
    const out = await runWritePipeline(
      {
        method: 'PUT',
        body: { title: 'new', _created: '1999-01-01T00:00:00.000Z' },
        existing: { title: 'old', _created: EARLIER },
        config: bare,
        userRoles: roles,
      },
      deps()
    )
    if (out.status !== 'write') throw new Error('expected write')
    expect(out.data._created).toBe(EARLIER)
  })
})

describe('PUT vs PATCH semantics (parity with doc.ts)', () => {
  test('PUT replaces — fields absent from the body are dropped', async () => {
    const out = await runWritePipeline(
      {
        method: 'PUT',
        body: { title: 'new' },
        existing: { title: 'old', subtitle: 'keep me?' },
        config: bare,
        userRoles: roles,
      },
      deps()
    )
    if (out.status !== 'write') throw new Error('expected write')
    expect(out.data.subtitle).toBeUndefined()
  })

  test('PATCH merges — untouched fields survive', async () => {
    const out = await runWritePipeline(
      {
        method: 'PATCH',
        body: { title: 'new' },
        existing: { title: 'old', subtitle: 'kept' },
        config: bare,
        userRoles: roles,
      },
      deps()
    )
    if (out.status !== 'write') throw new Error('expected write')
    expect(out.data.subtitle).toBe('kept')
    expect(out.data.title).toBe('new')
  })
})

describe('ordering is a security property (§3)', () => {
  const schema = s.object({
    title: s.string,
    _created: s.string.optional,
    _modified: s.string.optional,
  })

  test('schema rejection happens before the transform runs', async () => {
    let transformRan = false
    const config: CollectionConfig = {
      schema,
      validate: async (d) => {
        transformRan = true
        return d
      },
    }
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { title: 42 } as unknown as Record<string, unknown>,
        existing: null,
        config,
        userRoles: roles,
      },
      deps()
    )
    expect(out).toMatchObject({ status: 'rejected', reason: 'schema' })
    expect(transformRan).toBe(false)
  })

  test('uniqueness sees POST-transform data, so a transform cannot launder a value past it', async () => {
    const seen: unknown[] = []
    const config: CollectionConfig = {
      unique: ['slug'],
      // transform rewrites the unique field
      validate: async (d) => ({ ...d, slug: 'rewritten' }),
    }
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { slug: 'original' },
        existing: null,
        config,
        userRoles: roles,
      },
      deps({
        isUnique: async (_f, value) => {
          seen.push(value)
          return true
        },
      })
    )
    expect(out.status).toBe('write')
    // the uniqueness check must have been handed the transformed value
    expect(seen).toEqual(['rewritten'])
  })

  test('a transform returning an Error rejects the write', async () => {
    const config: CollectionConfig = {
      validate: async () => new Error('nope'),
    }
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { title: 't' },
        existing: null,
        config,
        userRoles: roles,
      },
      deps()
    )
    expect(out).toMatchObject({ status: 'rejected', reason: 'validate' })
  })

  test('a transform cannot write envelope fields (§4.1)', async () => {
    const config: CollectionConfig = {
      validate: async (d) => ({ ...d, _id: 'forged', _path: 'forged' }),
    }
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { title: 't' },
        existing: null,
        config,
        userRoles: roles,
      },
      deps()
    )
    if (out.status !== 'write') throw new Error('expected write')
    expect(out.data._id).toBeUndefined()
    expect(out.data._path).toBeUndefined()
  })
})

describe('uniqueness is reject-only (§4.2)', () => {
  test('a collision rejects with the field named', async () => {
    const config: CollectionConfig = { unique: ['path'] }
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { path: 'taken' },
        existing: null,
        config,
        userRoles: roles,
      },
      deps({ isUnique: async () => false })
    )
    expect(out).toMatchObject({ status: 'rejected', reason: 'unique' })
    if (out.status !== 'rejected') return
    expect(out.message).toContain('path')
  })

  test('no unique config means no privileged reads at all', async () => {
    let reads = 0
    await runWritePipeline(
      {
        method: 'POST',
        body: { title: 't' },
        existing: null,
        config: bare,
        userRoles: roles,
      },
      deps({
        isUnique: async () => {
          reads++
          return true
        },
      })
    )
    expect(reads).toBe(0)
  })
})

describe('the module.validate oracle ports intact', () => {
  // functions/src/collections/module.ts validate(): revisions=0 on create;
  // increments only when `source` changed. Same oracle as the tjs-lang baseline.
  const config: CollectionConfig = {
    validate: async (data, _roles, existing) => {
      const isUpdate = existing && Object.keys(existing).length > 0
      if (!isUpdate) {
        data.revisions = 0
      } else if (existing.source !== data.source) {
        data.revisions = (existing.revisions ?? 0) + 1
      }
      return data
    },
  }

  test('create sets revisions to 0', async () => {
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { source: 'a' },
        existing: null,
        config,
        userRoles: roles,
      },
      deps()
    )
    if (out.status !== 'write') throw new Error('expected write')
    expect(out.data.revisions).toBe(0)
  })

  test('changing source increments revisions', async () => {
    const out = await runWritePipeline(
      {
        method: 'PUT',
        body: { source: 'b' },
        existing: { source: 'a', revisions: 3, _created: EARLIER },
        config,
        userRoles: roles,
      },
      deps()
    )
    if (out.status !== 'write') throw new Error('expected write')
    expect(out.data.revisions).toBe(4)
  })

  test('a missing prior count does not produce NaN', async () => {
    const out = await runWritePipeline(
      {
        method: 'PUT',
        body: { source: 'b' },
        existing: { source: 'a', _created: EARLIER },
        config,
        userRoles: roles,
      },
      deps()
    )
    if (out.status !== 'write') throw new Error('expected write')
    expect(out.data.revisions).toBe(1)
  })
})

// ── The one deliberate divergence from today's doc.ts ───────────────────────
describe('DIVERGENCE: §3 no-op check (doc.ts does NOT do this)', () => {
  test('an unchanged body neither writes nor re-stamps', async () => {
    const out = await runWritePipeline(
      {
        method: 'PUT',
        body: { title: 'same' },
        existing: { title: 'same', _created: EARLIER, _modified: EARLIER },
        config: bare,
        userRoles: roles,
      },
      deps()
    )
    // doc.ts today would write and bump _modified to NOW.
    expect(out.status).toBe('noop')
  })

  test('a no-op performs no privileged reads', async () => {
    let reads = 0
    const out = await runWritePipeline(
      {
        method: 'PUT',
        body: { path: 'same' },
        existing: { path: 'same', _created: EARLIER },
        config: { unique: ['path'] },
        userRoles: roles,
      },
      deps({
        isUnique: async () => {
          reads++
          return true
        },
      })
    )
    expect(out.status).toBe('noop')
    expect(reads).toBe(0)
  })

  test('field order alone never forces a write', () => {
    expect(isUnchanged({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })

  test('a real content change still writes', async () => {
    const out = await runWritePipeline(
      {
        method: 'PUT',
        body: { title: 'different' },
        existing: { title: 'same', _created: EARLIER },
        config: bare,
        userRoles: roles,
      },
      deps()
    )
    expect(out.status).toBe('write')
  })

  test('a create is never a no-op', () => {
    expect(isUnchanged({ a: 1 }, null)).toBe(false)
    expect(isUnchanged({ a: 1 }, {})).toBe(false)
  })
})
