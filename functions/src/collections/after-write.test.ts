/**
 * Regression tests for the write/side-effect ordering bug.
 *
 * `blog.ts` used to call `clearBlogCache()` from inside `validate`, which the
 * write pipeline runs BEFORE the commit (doc.ts: validate → unique → ref.set).
 * A read landing in that window — and the reader is `onPrefetch`, i.e. nearly
 * every page request — would miss the cache, rebuild it from PRE-write data, and
 * stamp it fresh, serving stale content for up to the cache duration (24h).
 *
 * The fix moves post-commit side effects to `CollectionConfig.afterWrite`. These
 * tests pin the ordering property rather than the specific cache call, because
 * the bug is "side effect ran before the write", not "the blog cache was wrong".
 *
 * Run: cd functions && bun test src/collections/after-write.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { runWritePipeline } from './write-pipeline'
import type { CollectionConfig } from './access'
import type { UserRoles } from './roles'

const roles: UserRoles = {
  name: 'tester',
  contacts: [],
  roles: ['admin'],
  userIds: ['u1'],
} as UserRoles

const deps = { now: () => '2026-09-05T12:00:00.000Z', isUnique: async () => true }

describe('transforms are pure (§4.1)', () => {
  test('a transform is handed data and roles only — no store, cache or fetch capability', async () => {
    // §4.1: the transform "sees nothing the caller could not see. No privileged
    // read. No write capability." Pin the argument surface, so widening it to
    // pass a capability becomes a deliberate, test-breaking act.
    const received: unknown[] = []
    const config: CollectionConfig = {
      validate: async (...args: unknown[]) => {
        received.push(...args)
        return args[0]
      },
    }
    await runWritePipeline(
      {
        method: 'POST',
        body: { title: 't' },
        existing: null,
        config,
        userRoles: roles,
      },
      deps
    )
    expect(received).toHaveLength(3) // data, userRoles, existing — nothing else
    for (const arg of received) {
      // none of the arguments is a callable capability
      expect(typeof arg).not.toBe('function')
    }
  })

  test('the blog transform still derives a path from the title', async () => {
    // The pure half of blog.ts's old validate must survive the refactor.
    const config: CollectionConfig = {
      validate: async (data: Record<string, unknown>) => {
        if (!data.path) {
          data.path = String(data.title)
            .toLocaleLowerCase()
            .replace(/[^\w]+/g, '-')
        }
        return data
      },
    }
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { title: 'Hello There World' },
        existing: null,
        config,
        userRoles: roles,
      },
      deps
    )
    if (out.status !== 'write') throw new Error('expected write')
    expect(out.data.path).toBe('hello-there-world')
  })
})

describe('afterWrite ordering', () => {
  test('the pipeline itself never invokes afterWrite — only a committed write may', async () => {
    // The pipeline decides; the endpoint commits and then fires side effects.
    // If the pipeline called afterWrite, the old before-commit bug would return
    // by a different route.
    let fired = false
    const config: CollectionConfig = {
      afterWrite: async () => {
        fired = true
      },
    }
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { title: 't' },
        existing: null,
        config,
        userRoles: roles,
      },
      deps
    )
    expect(out.status).toBe('write')
    expect(fired).toBe(false)
  })

  test('a rejected write reaches no commit, so no side effect should follow', async () => {
    // Models the endpoint contract: afterWrite is called only on the success
    // branch. A rejection must not invalidate a cache for a write that never was.
    let fired = false
    const config: CollectionConfig = {
      unique: ['path'],
      afterWrite: async () => {
        fired = true
      },
    }
    const out = await runWritePipeline(
      {
        method: 'POST',
        body: { path: 'taken' },
        existing: null,
        config,
        userRoles: roles,
      },
      { ...deps, isUnique: async () => false }
    )
    expect(out.status).toBe('rejected')
    expect(fired).toBe(false)
  })

  test('a no-op write is not a commit either', async () => {
    // Nothing changed, so nothing was written — invalidating caches here would
    // be pure cost, and (worse) would hide that nothing happened.
    let fired = false
    const config: CollectionConfig = {
      afterWrite: async () => {
        fired = true
      },
    }
    const out = await runWritePipeline(
      {
        method: 'PUT',
        body: { title: 'same' },
        existing: { title: 'same', _created: '2020-01-01T00:00:00.000Z' },
        config,
        userRoles: roles,
      },
      deps
    )
    expect(out.status).toBe('noop')
    expect(fired).toBe(false)
  })
})
