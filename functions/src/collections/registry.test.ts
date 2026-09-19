/**
 * The collection registry, and the CROSS-ARCHITECTURE property it exists to
 * make testable (#5, #7).
 *
 * Once collection configs are data rather than compiled TypeScript, the central
 * claim of the whole design becomes checkable:
 *
 *   the same stored configuration produces the same behaviour on any substrate
 *
 * If that holds, a manifest can declare LOGICAL collections and mean it, and the
 * Firestore-to-Postgres path stays open. If it does not, "substrate-agnostic" is
 * marketing. So these tests do not merely compare compiled maps — they run
 * identical config through the real access engine and the real write pipeline
 * against two different stores and require the observable outcomes to match.
 *
 * Run: cd functions && bun test src/collections/registry.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import {
  CollectionRegistry,
  StaticConfigSource,
  compileStored,
  type ConfigSource,
  type StoredCollectionConfig,
} from './registry'
import { ALL, getMethodAccess, type REST_METHOD } from './access'
import { ROLES, type UserRoles, type RoleName } from './roles'
import { MemoryStore } from './store'
import { runWritePipeline } from './write-pipeline'

const who = (roles: string[]): UserRoles => ({
  name: 'x',
  contacts: [],
  roles: roles as RoleName[],
  userIds: ['uid'],
})

/** The platform's own `post`, expressed as DATA rather than TypeScript. */
const STORED: StoredCollectionConfig[] = [
  {
    name: 'post',
    namespace: null,
    collection: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          date: { type: 'string' },
          slug: { type: 'string' },
        },
        required: ['title'],
      },
      unique: ['slug'],
      access: [
        {
          role: ROLES.public,
          read: 'ALL',
          list: { visible: { field: 'date', op: 'nonEmpty' } },
        },
        { role: ROLES.author, write: 'ALL', list: 'ALL' },
      ],
    },
  },
  {
    name: 'virta:task',
    namespace: 'virta',
    collection: {
      schema: { type: 'object', properties: { title: { type: 'string' } } },
      access: [{ role: ROLES.admin, read: 'ALL', write: 'ALL', list: 'ALL' }],
    },
  },
]

describe('configs are data — the registry resolves them', () => {
  test('a stored config becomes a usable collection', async () => {
    const reg = new CollectionRegistry(new StaticConfigSource(STORED))
    const collections = await reg.collections()
    expect(getMethodAccess(collections, 'post', 'GET', who([]))).toBe(ALL)
  })

  test('installed and platform collections are treated identically', async () => {
    // The collapse: there is no "platform" case. `post` and `virta:task` are the
    // same kind of thing, differing only in namespace.
    const reg = new CollectionRegistry(new StaticConfigSource(STORED))
    const collections = await reg.collections()
    expect(
      getMethodAccess(collections, 'virta:task', 'POST', who([ROLES.admin]))
    ).toBe(ALL)
    expect(
      getMethodAccess(collections, 'post', 'POST', who([ROLES.author]))
    ).toBe(ALL)
  })

  test('an unknown collection is undefined — deny by default survives', async () => {
    const reg = new CollectionRegistry(new StaticConfigSource(STORED))
    expect(await reg.resolve('not-a-collection')).toBeUndefined()
  })
})

describe('no compiled authority — not even for owner', () => {
  test('an EMPTY config store denies everything, to everyone', async () => {
    // Deliberately no `owner => ALL` escape hatch: owner's power is datastore
    // access (D3), and a compiled bypass would be the in-system second root
    // DECISIONS.md already retracted. Empty store => inert, repairable only
    // through the datastore.
    const reg = new CollectionRegistry(new StaticConfigSource([]))
    const collections = await reg.collections()
    for (const role of Object.values(ROLES)) {
      for (const method of ['GET', 'LIST', 'POST', 'DELETE'] as REST_METHOD[]) {
        expect(
          getMethodAccess(collections, 'post', method, who([role]))
        ).toBeUndefined()
      }
    }
  })

  test('an UNREADABLE store fails closed rather than serving stale config', async () => {
    // Serving the last-known-good map would keep a revoked grant alive exactly
    // when the system has lost the ability to confirm it.
    const errors: string[] = []
    const broken: ConfigSource = {
      load: async () => {
        throw new Error('datastore unavailable')
      },
    }
    const reg = new CollectionRegistry(broken, {
      onError: (m) => errors.push(m),
    })
    expect(await reg.collections()).toEqual({})
    expect(errors.join()).toContain('load failed')
  })
})

describe('one bad config does not take down the host', () => {
  test('a malformed entry is isolated to its own collection', async () => {
    const errors: string[] = []
    const { collections, failed } = compileStored(
      [
        ...STORED,
        { name: 'broken', collection: null as never },
        { name: '', collection: null as never },
      ],
      (m) => errors.push(m)
    )
    // The good ones still work…
    expect(getMethodAccess(collections, 'post', 'GET', who([]))).toBe(ALL)
    // …the bad one is simply absent, i.e. denied.
    expect(collections.broken).toBeUndefined()
    expect(failed).toContain('broken')
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('caching — the part most likely to bite', () => {
  const source = (entries: StoredCollectionConfig[], counter: { n: number }) =>
    ({
      load: async () => {
        counter.n++
        return entries
      },
    }) as ConfigSource

  test('repeated reads hit the cache, not the store', async () => {
    const counter = { n: 0 }
    const reg = new CollectionRegistry(source(STORED, counter), {
      now: () => 1000,
    })
    await reg.collections()
    await reg.collections()
    await reg.collections()
    expect(counter.n).toBe(1)
  })

  test('the cache expires on the TTL', async () => {
    const counter = { n: 0 }
    let clock = 1000
    const reg = new CollectionRegistry(source(STORED, counter), {
      ttlMs: 500,
      now: () => clock,
    })
    await reg.collections()
    clock += 499
    await reg.collections()
    expect(counter.n).toBe(1)
    clock += 2
    await reg.collections()
    expect(counter.n).toBe(2)
  })

  test('invalidate() drops it immediately — a revocation cannot wait for a TTL', async () => {
    const counter = { n: 0 }
    const reg = new CollectionRegistry(source(STORED, counter), {
      now: () => 1000,
    })
    await reg.collections()
    reg.invalidate()
    await reg.collections()
    expect(counter.n).toBe(2)
  })

  test('concurrent cold reads collapse into ONE load', async () => {
    // A cold instance serving a burst must not stampede the config store.
    const counter = { n: 0 }
    const slow: ConfigSource = {
      load: async () => {
        counter.n++
        await new Promise((r) => setTimeout(r, 10))
        return STORED
      },
    }
    const reg = new CollectionRegistry(slow, { now: () => 1000 })
    await Promise.all([reg.collections(), reg.collections(), reg.collections()])
    expect(counter.n).toBe(1)
  })
})

/**
 * The cross-architecture property.
 *
 * Two independent `ConfigSource` implementations carrying identical data — one
 * a plain object, one reading documents back out of a `MemoryStore` exactly as
 * a Firestore-backed source would — must produce indistinguishable behaviour,
 * both in what the access engine decides and in what the write pipeline does.
 */
describe('CROSS-ARCHITECTURE: same data, same behaviour, any substrate', () => {
  /** A source that reads configs out of a document store, like Firestore would. */
  const storeBackedSource = (store: MemoryStore): ConfigSource => ({
    load: async () => {
      const rows = await store.query('collection')
      return rows.map((r) => r.data as unknown as StoredCollectionConfig)
    },
  })

  const seeded = async () => {
    const store = new MemoryStore()
    for (const entry of STORED) {
      await store.set(
        `collection/${entry.name.replace(/:/g, '__')}`,
        entry as unknown as Record<string, unknown>
      )
    }
    return store
  }

  test('both sources compile to the same collection names', async () => {
    const a = await new CollectionRegistry(
      new StaticConfigSource(STORED)
    ).collections()
    const b = await new CollectionRegistry(
      storeBackedSource(await seeded())
    ).collections()
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort())
  })

  test('the ACCESS ENGINE decides identically across substrates', async () => {
    const a = await new CollectionRegistry(
      new StaticConfigSource(STORED)
    ).collections()
    const b = await new CollectionRegistry(
      storeBackedSource(await seeded())
    ).collections()

    const roles = [[], [ROLES.public], [ROLES.author], [ROLES.admin]]
    const methods: REST_METHOD[] = ['GET', 'LIST', 'POST', 'PUT', 'DELETE']
    const names = ['post', 'virta:task', 'nope']

    for (const name of names) {
      for (const r of roles) {
        for (const m of methods) {
          const da = getMethodAccess(a, name, m, who(r))
          const db = getMethodAccess(b, name, m, who(r))
          // Compare observable kind, since compiled predicates are distinct
          // function objects by construction.
          const kind = (d: unknown) =>
            d === ALL ? 'ALL' : typeof d === 'function' ? 'fn' : 'deny'
          expect(`${name}/${r.join('+')}/${m}: ${kind(db)}`).toBe(
            `${name}/${r.join('+')}/${m}: ${kind(da)}`
          )
        }
      }
    }
  })

  test('a row-visibility predicate behaves identically across substrates', async () => {
    const a = await new CollectionRegistry(
      new StaticConfigSource(STORED)
    ).collections()
    const b = await new CollectionRegistry(
      storeBackedSource(await seeded())
    ).collections()

    const rows = [
      { title: 'draft', date: '' },
      { title: 'live', date: '2026-01-01' },
      { title: 'undated' },
    ]
    for (const row of rows) {
      const fa = getMethodAccess(a, 'post', 'LIST', who([])) as (
        r: unknown
      ) => Promise<unknown>
      const fb = getMethodAccess(b, 'post', 'LIST', who([])) as (
        r: unknown
      ) => Promise<unknown>
      const ra = await fa(row)
      const rb = await fb(row)
      expect(rb instanceof Error).toBe(ra instanceof Error)
      if (!(ra instanceof Error)) expect(rb).toEqual(ra)
    }
  })

  test('the WRITE PIPELINE agrees across substrates', async () => {
    const configs = await Promise.all([
      new CollectionRegistry(new StaticConfigSource(STORED)).collections(),
      new CollectionRegistry(storeBackedSource(await seeded())).collections(),
    ])

    const outcomes = []
    for (const collections of configs) {
      const store = new MemoryStore()
      const config = collections.post
      const deps = {
        now: () => '2026-09-19T00:00:00.000Z',
        isUnique: (f: string, v: unknown) =>
          store.isUnique('post', f, v, 'post/a'),
      }
      const results = []
      results.push(
        await runWritePipeline(
          {
            method: 'POST',
            body: { slug: 'a' },
            existing: {},
            exists: false,
            config,
            userRoles: who([ROLES.author]),
          },
          deps
        )
      )
      results.push(
        await runWritePipeline(
          {
            method: 'POST',
            body: { title: 'ok', slug: 'a' },
            existing: {},
            exists: false,
            config,
            userRoles: who([ROLES.author]),
          },
          deps
        )
      )
      outcomes.push(results.map((r) => `${r.status}:${(r as never as {reason?: string}).reason ?? ''}`))
    }
    expect(outcomes[1]).toEqual(outcomes[0])
    // …and it is actually exercising something, not two empty arrays.
    expect(outcomes[0]).toEqual(['rejected:schema', 'write:'])
  })
})

/**
 * Cross-instance invalidation — the requirement that if rules are updated, any
 * in-memory or cached copy is invalidated.
 *
 * `invalidate()` alone does NOT satisfy that: it clears the instance that
 * handled the request, while every other instance keeps serving the old rules
 * until its TTL expires. For a revocation that is the wrong failure — the grant
 * you just removed stays live on machines you are not looking at.
 *
 * These model two instances sharing one store, which is what production is.
 */
describe('a rule change reaches OTHER instances', () => {
  const sharedStore = () => {
    const state = { entries: STORED, epoch: 1, loads: 0, epochReads: 0 }
    const source = (): ConfigSource => ({
      load: async () => {
        state.loads++
        return state.entries
      },
      epoch: async () => {
        state.epochReads++
        return state.epoch
      },
    })
    return { state, source }
  }

  test('instance B picks up a change made by instance A', async () => {
    const { state, source } = sharedStore()
    let clock = 1000
    const opts = { now: () => clock, epochTtlMs: 100, ttlMs: 60_000 }
    const a = new CollectionRegistry(source(), opts)
    const b = new CollectionRegistry(source(), opts)

    expect(await a.resolve('post')).toBeDefined()
    expect(await b.resolve('post')).toBeDefined()

    // Instance A installs a change: the store is rewritten and the epoch moves.
    state.entries = STORED.filter((e) => e.name !== 'post')
    state.epoch = 2
    a.invalidate()

    // A sees it immediately — it did the write.
    expect(await a.resolve('post')).toBeUndefined()

    // B is still inside its hard TTL and has NOT been told anything. Without an
    // epoch check it would keep serving the removed collection.
    clock += 101
    expect(await b.resolve('post')).toBeUndefined()
  })

  test('an unchanged epoch does NOT trigger a reload', async () => {
    // The check has to be cheap in the steady state, or it is just a shorter TTL.
    const { state, source } = sharedStore()
    let clock = 1000
    const reg = new CollectionRegistry(source(), {
      now: () => clock,
      epochTtlMs: 100,
    })
    await reg.collections()
    expect(state.loads).toBe(1)
    for (let i = 0; i < 5; i++) {
      clock += 101
      await reg.collections()
    }
    expect(state.loads).toBe(1)
    expect(state.epochReads).toBeGreaterThan(1)
  })

  test('an unreadable epoch forces a reload rather than trusting the cache', async () => {
    // Freshness we cannot confirm is freshness we do not have.
    const state = { epoch: 1, loads: 0, fail: false }
    const source: ConfigSource = {
      load: async () => {
        state.loads++
        return STORED
      },
      epoch: async () => {
        if (state.fail) throw new Error('unreachable')
        return state.epoch
      },
    }
    let clock = 1000
    const reg = new CollectionRegistry(source, {
      now: () => clock,
      epochTtlMs: 100,
    })
    await reg.collections()
    expect(state.loads).toBe(1)
    state.fail = true
    clock += 101
    await reg.collections()
    expect(state.loads).toBe(2)
  })

  test('a source with no epoch falls back to TTL — weaker, and honest about it', async () => {
    const counter = { n: 0 }
    let clock = 1000
    const reg = new CollectionRegistry(
      { load: async () => { counter.n++; return STORED } },
      { now: () => clock, ttlMs: 500, epochTtlMs: 100 }
    )
    await reg.collections()
    clock += 200
    await reg.collections()
    expect(counter.n).toBe(1)
  })
})
