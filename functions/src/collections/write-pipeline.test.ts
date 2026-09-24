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

describe('a CLOSED schema accepts a valid write (#16)', () => {
  // Reported by the first consumer to try `additionalProperties: false`. The
  // pipeline stamps `_created`/`_modified` and then validated the STAMPED
  // document against the caller's schema, so the envelope it had just added
  // tripped the caller's own closed schema: every write failed with
  // "Unexpected _created".
  //
  // It also broke a promise larger than the feature — the same JSON Schema
  // validated locally accepted a document the host refused.
  const closed: CollectionConfig = {
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string' },
      },
      required: ['id', 'kind'],
      additionalProperties: false,
    } as never,
  }

  const event = { id: 'e1', kind: 'created' }

  test('POST is accepted', async () => {
    const outcome = await runWritePipeline(
      { method: 'POST', body: event, existing: {}, exists: false, config: closed, userRoles: roles },
      deps()
    )
    expect(outcome.status).toBe('write')
  })

  test('PUT is accepted', async () => {
    const outcome = await runWritePipeline(
      {
        method: 'PUT',
        body: { ...event, kind: 'tagged' },
        existing: { ...event, _created: EARLIER, _modified: EARLIER },
        exists: true,
        config: closed,
        userRoles: roles,
      },
      deps()
    )
    expect(outcome.status).toBe('write')
  })

  test('PATCH is accepted — the merge pulls stored stamps in, too', async () => {
    const outcome = await runWritePipeline(
      {
        method: 'PATCH',
        body: { kind: 'tagged' },
        existing: { ...event, _created: EARLIER, _modified: EARLIER },
        exists: true,
        config: closed,
        userRoles: roles,
      },
      deps()
    )
    expect(outcome.status).toBe('write')
  })

  test('the stamps are still STORED — hidden from the schema, not dropped', async () => {
    const outcome = await runWritePipeline(
      { method: 'POST', body: event, existing: {}, exists: false, config: closed, userRoles: roles },
      deps()
    )
    expect((outcome as { data: Record<string, unknown> }).data).toMatchObject({
      id: 'e1',
      _created: NOW,
      _modified: NOW,
    })
  })

  test('and a genuinely unexpected field is STILL rejected', async () => {
    // The fix must not turn a closed schema into an open one.
    const outcome = await runWritePipeline(
      {
        method: 'POST',
        body: { ...event, sneaky: true },
        existing: {},
        exists: false,
        config: closed,
        userRoles: roles,
      },
      deps()
    )
    expect(outcome.status).toBe('rejected')
    expect((outcome as { reason: string }).reason).toBe('schema')
    expect(JSON.stringify((outcome as { details: unknown }).details)).toContain('sneaky')
  })

  test('a caller CANNOT smuggle a stamp past the schema', async () => {
    // `_created` sent by a caller must not become a way to write a field the
    // schema would otherwise refuse, nor to forge provenance.
    const outcome = await runWritePipeline(
      {
        method: 'POST',
        body: { ...event, _created: '1999-01-01T00:00:00.000Z' },
        existing: {},
        exists: false,
        config: closed,
        userRoles: roles,
      },
      deps()
    )
    expect(outcome.status).toBe('write')
    expect((outcome as { data: Record<string, unknown> }).data._created).toBe(NOW)
  })
})

describe('provenance is stamped, not claimed (#18)', () => {
  const withToken: UserRoles = {
    ...roles,
    _id: 'role-1',
    token: { id: 'tok-1', label: 'ci × virta', methods: ['POST'] },
  } as UserRoles
  const human: UserRoles = { ...roles, _id: 'role-1' } as UserRoles
  const nobody: UserRoles = {
    name: 'unknown',
    contacts: [],
    roles: [],
    userIds: [],
  } as UserRoles

  const write = (userRoles: UserRoles, config: CollectionConfig = bare, body = { t: 'x' }) =>
    runWritePipeline(
      { method: 'POST', body, existing: {}, exists: false, config, userRoles },
      deps()
    )

  test('a token write records the token AND its label', async () => {
    const o = await write(withToken)
    expect((o as { data: Record<string, unknown> }).data._by).toEqual({
      uid: 'u1',
      role: 'role-1',
      name: 'tester',
      token: 'tok-1',
      label: 'ci × virta',
    })
  })

  test('a human write records the principal, with no token', async () => {
    // A token is NOT always present — a browser session carries a Firebase ID
    // token and no capability token at all.
    const o = await write(human)
    expect((o as { data: Record<string, unknown> }).data._by).toEqual({
      uid: 'u1',
      role: 'role-1',
      name: 'tester',
    })
  })

  test('two agents of ONE human are distinguishable', async () => {
    // The case that matters here: a token attenuates its human's authority, so
    // every agent a person mints shares their `uid`. The label is the only
    // thing that tells one from another — and from the human.
    const ci = { ...withToken, token: { id: 't1', label: 'ci × virta', methods: [] } } as UserRoles
    const laptop = { ...withToken, token: { id: 't2', label: 'macbook × virta', methods: [] } } as UserRoles
    const a = (await write(ci)) as { data: Record<string, Record<string, unknown>> }
    const b = (await write(laptop)) as { data: Record<string, Record<string, unknown>> }
    expect(a.data._by.uid).toBe(b.data._by.uid as string)
    expect(a.data._by.label).not.toBe(b.data._by.label as string)
    expect(a.data._by.token).not.toBe(b.data._by.token as string)
  })

  test('an unattributable write records NOTHING rather than an empty identity', async () => {
    // `_by: {}` would be a shape that looks like provenance and carries none.
    const o = await write(nobody)
    expect((o as { data: Record<string, unknown> }).data._by).toBeUndefined()
  })

  test('a caller cannot forge it', async () => {
    const o = await write(human, bare, { t: 'x', _by: { uid: 'someone-else' } } as never)
    expect((o as { data: Record<string, unknown> }).data._by).toEqual({
      uid: 'u1',
      role: 'role-1',
      name: 'tester',
    })
  })

  test('it is hidden from a CLOSED schema, like the other stamps', async () => {
    const closed: CollectionConfig = {
      schema: {
        type: 'object',
        properties: { t: { type: 'string' } },
        required: ['t'],
        additionalProperties: false,
      } as never,
    }
    expect((await write(withToken, closed)).status).toBe('write')
  })

  test('requireAttribution refuses an anonymous write', async () => {
    const strict: CollectionConfig = { requireAttribution: true }
    const o = await write(nobody, strict)
    expect(o).toMatchObject({ status: 'rejected', reason: 'unattributed' })
    // …and accepts an attributable one.
    expect((await write(human, strict)).status).toBe('write')
  })

  test('without it, an anonymous write is still allowed', async () => {
    // Opt-in: "anyone may write, anonymously" is a real configuration. The
    // point is that it should be chosen rather than arrived at.
    expect((await write(nobody)).status).toBe('write')
  })
})

describe('an immutable collection is a log, not a table (#25)', () => {
  const log: CollectionConfig = { immutable: true, seq: true }
  // A stored event as a replica has already folded it: stamped, sequenced,
  // attributed by someone else.
  const stored = {
    kind: 'created',
    at: EARLIER,
    _created: EARLIER,
    _modified: EARLIER,
    _seq: 41,
    _by: { uid: 'someone-else' },
  }
  const write = (
    method: 'POST' | 'PUT' | 'PATCH',
    body: Record<string, unknown>,
    existing: Record<string, unknown> | null = stored,
    config: CollectionConfig = log
  ) =>
    runWritePipeline(
      { method, body, existing, config, userRoles: roles },
      deps()
    )

  test('an identical re-write is a no-op — the torn-commit retry', async () => {
    // Stamps, `_seq` and `_by` differ from the body and must not count: the
    // retry comes from a different clock and possibly a different principal.
    expect((await write('PUT', { kind: 'created', at: EARLIER })).status).toBe(
      'noop'
    )
    expect((await write('PATCH', { kind: 'created' })).status).toBe('noop')
  })

  test('a different body is refused, never replaced', async () => {
    // virta's re-import: same id, a freshly stamped `at`. Upsert would have
    // replaced it and assigned a new `_seq`, moving history.
    const o = await write('PUT', { kind: 'created', at: NOW })
    expect(o).toMatchObject({ status: 'rejected', reason: 'immutable' })
  })

  test('a PATCH cannot sneak a change in by merging', async () => {
    const o = await write('PATCH', { note: 'added later' })
    expect(o).toMatchObject({ status: 'rejected', reason: 'immutable' })
  })

  test('the message names no path — the endpoint adds that', async () => {
    const o = (await write('PUT', { kind: 'other' })) as { message: string }
    expect(o.message).not.toContain('/')
  })

  test('creating is unaffected', async () => {
    expect((await write('POST', { kind: 'created' }, null)).status).toBe('write')
  })

  test('an empty stored document is still stored', async () => {
    // Firestore permits `set({})`; `existing` has no keys but the document
    // exists, and a write must not treat it as free to replace.
    const o = await runWritePipeline(
      {
        method: 'PUT',
        body: { kind: 'x' },
        existing: {},
        exists: true,
        config: log,
        userRoles: roles,
      },
      deps()
    )
    expect(o).toMatchObject({ status: 'rejected', reason: 'immutable' })
  })

  test('the comparison is post-transform, like the no-op test', async () => {
    // A transform that fills a field the body omits makes the retry identical
    // to what is stored — and one that is not a pure function of the body
    // would make it differ. Either way the decision is about what would LAND.
    const withDefault: CollectionConfig = {
      immutable: true,
      validate: async (d) => ({ ...d, at: d.at ?? EARLIER }),
    }
    expect((await write('PUT', { kind: 'created' }, stored, withDefault)).status).toBe(
      'noop'
    )
  })

  test('without the flag, a sequenced collection still upserts', async () => {
    // Opt-in, like `seq`. Pinned so that changing the default is a decision
    // somebody makes, not a side effect.
    const o = await write('PUT', { kind: 'created', at: NOW }, stored, { seq: true })
    expect(o.status).toBe('write')
  })
})
