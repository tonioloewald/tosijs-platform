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
    } as ConfigSource)

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
      outcomes.push(
        results.map(
          (r) =>
            `${r.status}:${(r as never as { reason?: string }).reason ?? ''}`
        )
      )
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
      {
        load: async () => {
          counter.n++
          return STORED
        },
      },
      { now: () => clock, ttlMs: 500, epochTtlMs: 100 }
    )
    await reg.collections()
    clock += 200
    await reg.collections()
    expect(counter.n).toBe(1)
  })
})

describe('the TTL reload happens in the BACKGROUND when the epoch vouches for the cache', () => {
  // Measured on a production clone: paying the 60 s reload inline put a full
  // load + compile on one request per instance per minute (p99 ~950 ms vs
  // ~330 ms). The epoch is what makes a snapshot trustworthy; the TTL reload is
  // belt-and-braces and need not block anyone.
  const store = () => {
    const state = { entries: STORED, epoch: 1, loads: 0, release: () => undefined as void }
    let gate: Promise<void> = Promise.resolve()
    const source: ConfigSource = {
      load: async () => {
        state.loads++
        await gate
        return state.entries
      },
      epoch: async () => state.epoch,
    }
    const hold = () => {
      gate = new Promise((r) => (state.release = r))
    }
    return { state, source, hold }
  }

  test('past the TTL, an unchanged epoch serves the snapshot WITHOUT waiting for the reload', async () => {
    const { state, source, hold } = store()
    let clock = 1000
    const reg = new CollectionRegistry(source, { now: () => clock, ttlMs: 500, epochTtlMs: 100 })
    await reg.collections()
    expect(state.loads).toBe(1)

    hold() // the next load will not finish until released
    clock += 501
    // Resolves even though the reload is blocked — i.e. it was not awaited.
    expect(await reg.resolve('post')).toBeDefined()
    expect(state.loads).toBe(2) // but it WAS started
    state.release()
  })

  test('a CHANGED epoch still reloads inline — a revocation is never served stale', async () => {
    const { state, source } = store()
    let clock = 1000
    const reg = new CollectionRegistry(source, { now: () => clock, ttlMs: 500, epochTtlMs: 100 })
    await reg.collections()
    state.entries = STORED.filter((e) => e.name !== 'post')
    state.epoch = 2
    clock += 501
    expect(await reg.resolve('post')).toBeUndefined()
  })

  test('a background reload collapses with any concurrent one', async () => {
    const { state, source, hold } = store()
    let clock = 1000
    const reg = new CollectionRegistry(source, { now: () => clock, ttlMs: 500, epochTtlMs: 100 })
    await reg.collections()
    hold()
    clock += 501
    await reg.collections()
    clock += 101 // re-check the epoch while the first background reload is still running
    await reg.collections()
    expect(state.loads).toBe(2)
    state.release()
  })
})

describe('reload races (0.2.0-beta.5 review)', () => {
  const without = (name: string) => STORED.filter((e) => e.name !== name)

  test('a change landing MID-LOAD never leaves old rules tagged as current', async () => {
    // Epoch read AFTER the load used to pair old entries with the new epoch,
    // and every later check then confirmed them. Read first, the next check
    // sees the epoch has moved and reloads.
    const state = { entries: STORED, epoch: 1, changeDuringLoad: false }
    const source: ConfigSource = {
      load: async () => {
        const e = state.entries
        if (state.changeDuringLoad) {
          state.entries = without('post')
          state.epoch = 2
          state.changeDuringLoad = false
        }
        return e
      },
      epoch: async () => state.epoch,
    }
    let clock = 1000
    const reg = new CollectionRegistry(source, { now: () => clock, epochTtlMs: 100 })
    state.changeDuringLoad = true
    expect(await reg.resolve('post')).toBeDefined() // loaded the pre-change set
    clock += 101
    expect(await reg.resolve('post')).toBeUndefined() // and noticed the change
  })

  test('after a change is seen, a request does NOT join a load that started before it', async () => {
    let release = () => undefined as void
    const state = { entries: STORED, epoch: 1, loads: 0, block: false }
    const source: ConfigSource = {
      load: async () => {
        state.loads++
        const snapshotOfEntries = state.entries
        if (state.block) {
          state.block = false
          await new Promise<void>((r) => (release = r))
        }
        return snapshotOfEntries
      },
      epoch: async () => state.epoch,
    }
    let clock = 1000
    const reg = new CollectionRegistry(source, { now: () => clock, ttlMs: 500, epochTtlMs: 100 })
    await reg.collections()
    // A background reload starts (TTL passed, epoch unchanged) and stalls,
    // holding the OLD entries.
    state.block = true
    clock += 501
    await reg.collections()
    // Now the rules change.
    state.entries = without('post')
    state.epoch = 2
    clock += 101
    expect(await reg.resolve('post')).toBeUndefined()
    // The stalled, stale load finishing late must not overwrite the new rules.
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(await reg.resolve('post')).toBeUndefined()
  })

  test('a FAILED BACKGROUND reload keeps the snapshot the epoch confirmed', async () => {
    // Emptying it would take every collection on the instance offline for a
    // transient read error — broader than the owner's per-collection rule.
    const state = { fail: false }
    const source: ConfigSource = {
      load: async () => {
        if (state.fail) throw new Error('transient')
        return STORED
      },
      epoch: async () => 1,
    }
    let clock = 1000
    const reg = new CollectionRegistry(source, { now: () => clock, ttlMs: 500, epochTtlMs: 100 })
    await reg.collections()
    state.fail = true
    clock += 501
    await reg.collections() // background reload starts and fails
    await new Promise((r) => setTimeout(r, 0))
    clock += 101
    expect(await reg.resolve('post')).toBeDefined()
  })

  test('a failed INLINE load still fails closed', async () => {
    const source: ConfigSource = {
      load: async () => {
        throw new Error('down')
      },
      epoch: async () => 1,
    }
    const reg = new CollectionRegistry(source, { now: () => 1000 })
    expect(await reg.resolve('post')).toBeUndefined()
  })

  test('invalidate() discards a load that was already in flight', async () => {
    let release = () => undefined as void
    const state = { entries: STORED, first: true }
    const source: ConfigSource = {
      load: async () => {
        const e = state.entries
        if (state.first) {
          state.first = false
          await new Promise<void>((r) => (release = r))
        }
        return e
      },
    }
    const reg = new CollectionRegistry(source, { now: () => 1000 })
    const stale = reg.collections() // starts, stalls with the old entries
    state.entries = without('post')
    reg.invalidate()
    expect(await reg.resolve('post')).toBeUndefined() // a new load, new rules
    release()
    await stale
    expect(await reg.resolve('post')).toBeUndefined() // the stale load did not win
  })
})
