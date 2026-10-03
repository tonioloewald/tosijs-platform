import { describe, test, expect } from 'bun:test'
import { ComputedStore, MemoryBackend, depsOfWrite } from './computed'

const counting = (value: unknown, storable = true) => {
  let calls = 0
  return {
    fn: async () => {
      calls++
      return { value, storable }
    },
    calls: () => calls,
  }
}

describe('ComputedStore', () => {
  test('computes on a miss, then serves the stored value with no work', async () => {
    const store = new ComputedStore(new MemoryBackend(), 'v1')
    const c = counting({ a: 1 })
    expect(await store.get('k', c.fn)).toEqual({ a: 1 })
    expect(await store.get('k', c.fn)).toEqual({ a: 1 })
    expect(c.calls()).toBe(1)
  })

  test('invalidate marks stale; the next read recomputes', async () => {
    const store = new ComputedStore(new MemoryBackend(), 'v1')
    await store.get('k', counting(1).fn)
    await store.invalidate(['k'])
    expect(await store.peek('k')).toBeUndefined()
    expect(await store.get('k', counting(2).fn)).toBe(2)
    expect(await store.peek('k')).toBe(2)
  })

  test('a result that is not storable is returned but never kept (a draft)', async () => {
    const store = new ComputedStore(new MemoryBackend(), 'v1')
    expect(await store.get('k', counting('draft', false).fn)).toBe('draft')
    expect(await store.peek('k')).toBeUndefined()
  })

  test('THE RACE: a read computing across an invalidation does not store its pre-write value', async () => {
    const backend = new MemoryBackend()
    const store = new ComputedStore(backend, 'v1')
    let release: () => void = () => undefined
    const slow = async () => {
      await new Promise<void>((r) => (release = r)) // computing from pre-write data…
      return { value: 'pre-write', storable: true }
    }
    const reading = store.get('k', slow)
    await new Promise((r) => setTimeout(r, 0))
    await store.invalidate(['k']) // …the write lands and invalidates
    release()
    expect(await reading).toBe('pre-write') // its caller still gets an answer
    expect(await store.peek('k')).toBeUndefined() // but it was NOT kept
    expect(await store.get('k', counting('post-write').fn)).toBe('post-write')
  })

  test('a version bump is a new namespace (its own storage): everything misses (no render-all)', async () => {
    await new ComputedStore(new MemoryBackend(), 'v1').get('k', counting('old').fn)
    const v2 = new ComputedStore(new MemoryBackend(), 'v2')
    const c = counting('new')
    expect(await v2.get('k', c.fn)).toBe('new')
    expect(c.calls()).toBe(1)
  })

  test('getMany reads in one go and fills only the misses', async () => {
    const store = new ComputedStore(new MemoryBackend(), 'v1')
    await store.get('a', counting('A').fn)
    let computed: string[] = []
    const out = await store.getMany(['a', 'b'], async (k) => {
      computed.push(k)
      return { value: k.toUpperCase(), storable: true }
    })
    expect(out).toEqual(['A', 'B'])
    expect(computed).toEqual(['b'])
    computed = []
    await store.getMany(['a', 'b'], async (k) => ({ value: k, storable: true }))
    expect(computed).toEqual([])
  })
})

describe('recorded dependencies — no hand-written invalidation rules', () => {
  test('a write invalidates exactly what read it; reads of other things are untouched', async () => {
    const store = new ComputedStore(new MemoryBackend(), 'v1')
    await store.get('page:a', async (d) => (d.add('doc:post/1'), { value: 'A', storable: true }))
    await store.get('page:b', async (d) => (d.add('doc:post/2'), { value: 'B', storable: true }))
    expect(await store.invalidateDependents(['doc:post/1'])).toEqual(['page:a'])
    expect(await store.peek('page:a')).toBeUndefined()
    expect(await store.peek('page:b')).toBe('B')
  })

  test('invalidation CASCADES through computed values that read other computed values', async () => {
    const store = new ComputedStore(new MemoryBackend(), 'v1')
    const index = (d: { add: (x: string) => void }) => (d.add('list:post'), Promise.resolve({ value: ['p1'], storable: true }))
    // The route reads the index; it records `computed:index`.
    await store.get('route', async (d) => {
      const idx = await store.get('index', index, { parent: d })
      return { value: `latest ${idx[0]}`, storable: true }
    })
    expect(await store.depsOf('route')).toContain('computed:v1:index')
    const hit = await store.invalidateDependents(['list:post'])
    expect(hit.sort()).toEqual(['index', 'route'])
  })

  test('depsOfWrite: the document, its list, and every lookup field before AND after (a rename moves it)', () => {
    expect(depsOfWrite('post', 'id1', { path: 'old' }, { path: 'new' }, ['path']).sort()).toEqual(
      ['doc:post/id1', 'doc:post/path=new', 'doc:post/path=old', 'list:post'].sort()
    )
    expect(depsOfWrite('post', 'id1', undefined, { path: 'p' }, ['path'])).toContain('doc:post/path=p')
  })
})

describe('THE FIRST-FILL RACE (adversarial review 2026-10-03, correctness B1)', () => {
  test('a key that did not exist yet, computed across a write, is not left fresh', async () => {
    let t = 1_000
    const backend = new MemoryBackend(() => t)
    const store = new ComputedStore(backend, 'v1', { now: () => t, skewMs: 0 })
    let release: () => void = () => undefined
    // R misses K (it does not exist) and reads the post's OLD content…
    const reading = store.get('K', async (d) => {
      d.add('doc:post/p')
      await new Promise<void>((r) => (release = r))
      return { value: 'old post', storable: true }
    })
    await new Promise((r) => setTimeout(r, 0))
    // …the writer commits P: dependents() cannot see K (it does not exist yet)…
    t += 5
    expect(await store.invalidateDependents(['doc:post/p'])).toEqual([])
    // …and R's create succeeds afterwards.
    t += 5
    release()
    expect(await reading).toBe('old post') // its caller still gets an answer
    expect(await store.peek('K')).toBeUndefined() // but the log made it stale
    expect(await store.get('K', counting('new post').fn)).toBe('new post')
  })

  test('…and a compute that saw no write since it started stays fresh', async () => {
    let t = 1_000
    const backend = new MemoryBackend(() => t)
    const store = new ComputedStore(backend, 'v1', { now: () => t, skewMs: 0 })
    await store.invalidateDependents(['doc:post/p']) // an OLD write
    t += 100
    await store.get('K', async (d) => (d.add('doc:post/p'), { value: 'v', storable: true }))
    expect(await store.peek('K')).toBe('v')
  })

  test('a store failure that is not a race is REPORTED, not treated as a lost race', async () => {
    const backend = new MemoryBackend()
    backend.writeIfUnchanged = async () => {
      throw new Error('document too large')
    }
    const errors: string[] = []
    const store = new ComputedStore(backend, 'v1', { onError: (what, e) => errors.push(`${what}: ${(e as Error).message}`) })
    expect(await store.get('K', counting('v').fn)).toBe('v')
    expect(errors).toEqual(['store v1:K: document too large'])
  })

  test('the default policy (backstop max age) applies to every get', async () => {
    let t = 1_000_000
    const store = new ComputedStore(new MemoryBackend(), 'v1', { now: () => t, defaultPolicy: { maxAgeSeconds: 60 } })
    await store.get('K', counting('first').fn)
    t += 61_000
    expect(await store.get('K', counting('second').fn)).toBe('second')
  })
})

describe('policies — transparent caching for values no write announces', () => {
  test('maxAgeSeconds: fresh until it is old, then recomputed', async () => {
    let t = 1_000_000
    const store = new ComputedStore(new MemoryBackend(), 'v1', { now: () => t })
    const policy = { maxAgeSeconds: 60 }
    expect(await store.get('q', counting('first').fn, { policy })).toBe('first')
    t += 30_000
    expect(await store.get('q', counting('second').fn, { policy })).toBe('first')
    t += 31_000
    expect(await store.get('q', counting('third').fn, { policy })).toBe('third')
  })

  test('validate: a checksum stored with the value, compared on read', async () => {
    const store = new ComputedStore(new MemoryBackend(), 'v1')
    let sourceSum = 'aaa'
    const policy = { validate: async (e: { check?: string }) => e.check === sourceSum }
    const compute = (v: string) => async () => ({ value: v, storable: true, check: sourceSum })
    expect(await store.get('k', compute('v1'), { policy })).toBe('v1')
    expect(await store.get('k', compute('v2'), { policy })).toBe('v1') // sources unchanged
    sourceSum = 'bbb'
    expect(await store.get('k', compute('v3'), { policy })).toBe('v3') // sources changed
  })
})

describe('re-review: the store, not each renderer, decides what may be kept', () => {
  test('a value that read something no write invalidates is returned, reported, and NOT stored', async () => {
    const errors: string[] = []
    const store = new ComputedStore(new MemoryBackend(), 'v1', {
      isInvalidatedDep: (d) => d.startsWith('doc:post/') || d.startsWith('computed:'),
      onError: (what) => errors.push(what),
    })
    expect(await store.get('k', async (d) => (d.add('doc:secret/1'), { value: 'x', storable: true }))).toBe('x')
    expect(await store.peek('k')).toBeUndefined()
    expect(errors).toEqual(['not storing v1:k'])
    await store.get('ok', async (d) => (d.add('doc:post/1'), { value: 'y', storable: true }))
    expect(await store.peek('ok')).toBe('y')
  })

  test('cannotStore(reason) keeps a value out of the store', async () => {
    const store = new ComputedStore(new MemoryBackend(), 'v1')
    await store.get('k', async (d) => (d.cannotStore('lookup by a non-unique field'), { value: 'x', storable: true }))
    expect(await store.peek('k')).toBeUndefined()
  })

  test('a failed LOG write still marks the dependents stale (re-review M1)', async () => {
    const backend = new MemoryBackend()
    const store = new ComputedStore(backend, 'v1')
    await store.get('k', async (d) => (d.add('doc:post/1'), { value: 'v', storable: true }))
    backend.logInvalidation = async () => {
      throw new Error('contention')
    }
    expect(await store.invalidateDependents(['doc:post/1'])).toEqual(['k'])
    expect(await store.peek('k')).toBeUndefined()
  })
})

