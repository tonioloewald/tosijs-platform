/**
 * The substrate port, exercised end-to-end against a SECOND substrate
 * (tosijs-platform#7).
 *
 * This is the payoff the port was for. `runWritePipeline` + `MemoryStore`
 * reproduce the whole decide-then-commit sequence `/doc` performs — existence
 * guards, PATCH-vs-PUT merge, provenance stamping, the §3 no-op, self-excluding
 * uniqueness — with **no emulator, no network and no credentials**.
 *
 * Until now that sequence could only be verified against live Firestore, which
 * is why `write-path.integration.test.ts` is skip-guarded and why three real
 * bugs sat undetected behind vacuous passes. Here the same code runs in
 * milliseconds.
 *
 * It is also the acceptance test for the port's central claim: the endpoint's
 * behaviour is a property of the pipeline and the config, not of Firestore. If
 * these pass against `MemoryStore` and the integration suite passes against
 * Firestore, the two substrates agree — which is what has to be true before a
 * manifest can declare *logical* collections and mean it.
 *
 * Run: cd functions && bun test src/collections/store.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import { MemoryStore } from './store'
import { runWritePipeline } from './write-pipeline'
import { ROLES, type UserRoles, type RoleName } from './roles'
import { ALL, type CollectionConfig } from './access'

const user = (roles: string[] = [ROLES.admin]): UserRoles => ({
  name: 'Test',
  contacts: [],
  roles: roles as RoleName[],
  userIds: ['uid'],
})

const NOW = '2026-09-17T00:00:00.000Z'

const config: CollectionConfig = {
  unique: ['slug'],
  access: { [ROLES.admin]: { read: ALL, write: ALL, list: ALL } },
}

/**
 * The same decide-then-commit dance `doc.ts` performs, against any Store.
 * Deliberately mirrors the endpoint rather than the pipeline alone: the thing
 * worth testing is the composition.
 */
const write = async (
  store: MemoryStore,
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  body: Record<string, unknown>,
  now = NOW
) => {
  const canonical = await store.resolve(path)
  if (canonical instanceof Error) return { status: 'unresolved', error: canonical }
  const doc = await store.get(canonical)
  const outcome = await runWritePipeline(
    { method, body, existing: doc.data, exists: doc.exists, config, userRoles: user() },
    {
      now: () => now,
      isUnique: (field, value) =>
        store.isUnique(canonical.split('/')[0], field, value, canonical),
    }
  )
  if (outcome.status === 'write') await store.set(canonical, outcome.data)
  return outcome
}

describe('write pipeline over MemoryStore — no emulator', () => {
  test('POST creates and stamps provenance from the injected clock', async () => {
    const store = new MemoryStore()
    const out = await write(store, 'POST', 'post/a', { title: 'A', slug: 'a' })
    expect(out.status).toBe('write')
    const doc = await store.get('post/a')
    expect(doc.exists).toBe(true)
    expect(doc.data._created).toBe(NOW)
    expect(doc.data._modified).toBe(NOW)
  })

  test('POST onto an existing document is refused', async () => {
    const store = new MemoryStore({ 'post/a': { title: 'A' } })
    const out = await write(store, 'POST', 'post/a', { title: 'B' })
    expect(out).toMatchObject({ status: 'rejected', reason: 'exists' })
  })

  test('PUT/PATCH onto a missing document is refused', async () => {
    const store = new MemoryStore()
    for (const method of ['PUT', 'PATCH'] as const) {
      const out = await write(store, method, 'post/missing', { title: 'X' })
      expect(out).toMatchObject({ status: 'rejected', reason: 'missing' })
    }
  })

  test('an EMPTY stored document still counts as existing', async () => {
    // The divergence explicit `exists` was added for: inferring existence from
    // an empty body would let a POST silently overwrite a real document.
    const store = new MemoryStore({ 'post/empty': {} })
    const out = await write(store, 'POST', 'post/empty', { title: 'X' })
    expect(out).toMatchObject({ status: 'rejected', reason: 'exists' })
  })

  test('PATCH merges over stored content, PUT replaces it', async () => {
    // `slug` must be present: a `unique` field is implicitly MANDATORY, because
    // `isUnique` refuses a non-scalar value. Omitting it here made the PATCH
    // reject with `unique` rather than merge — worth knowing before writing a
    // config, and pinned as its own test below.
    const store = new MemoryStore({
      'post/a': {
        title: 'A',
        body: 'keep',
        slug: 'a',
        _created: '2020-01-01T00:00:00.000Z',
      },
    })
    await write(store, 'PATCH', 'post/a', { title: 'A2' })
    expect((await store.get('post/a')).data).toMatchObject({
      title: 'A2',
      body: 'keep',
    })

    await write(store, 'PUT', 'post/a', { title: 'A3', slug: 'a' })
    const afterPut = (await store.get('post/a')).data
    expect(afterPut.title).toBe('A3')
    expect(afterPut.body).toBeUndefined()
    // `_created` survives a replace — it is provenance, not content.
    expect(afterPut._created).toBe('2020-01-01T00:00:00.000Z')
  })

  test('an unchanged body is a no-op and does not re-stamp', async () => {
    const store = new MemoryStore()
    await write(store, 'POST', 'post/a', { title: 'A', slug: 'a' })
    const out = await write(
      store,
      'PUT',
      'post/a',
      { title: 'A', slug: 'a' },
      '2027-01-01T00:00:00.000Z'
    )
    expect(out.status).toBe('noop')
    expect((await store.get('post/a')).data._modified).toBe(NOW)
  })

  test('uniqueness rejects a collision but NOT the document itself', async () => {
    const store = new MemoryStore()
    await write(store, 'POST', 'post/a', { title: 'A', slug: 'shared' })
    await write(store, 'POST', 'post/b', { title: 'B', slug: 'b' })

    // b taking a's slug collides...
    const collide = await write(store, 'PUT', 'post/b', {
      title: 'B',
      slug: 'shared',
    })
    expect(collide).toMatchObject({ status: 'rejected', reason: 'unique' })

    // ...but a re-saving its OWN slug must not. This is the self-exclusion that
    // review F12 predicted would break every update if dropped.
    const resave = await write(store, 'PUT', 'post/a', {
      title: 'A changed',
      slug: 'shared',
    })
    expect(resave.status).toBe('write')
  })
})

describe('write pipeline over MemoryStore — no emulator (cont.)', () => {
  /**
   * A `unique` field is implicitly MANDATORY, which the config format does not
   * say anywhere and which is easy to trip over: `isUnique` returns false for a
   * non-scalar, so a write that omits the field is rejected with reason
   * `unique` rather than anything resembling "missing field".
   *
   * Found by this suite's own fixture getting it wrong.
   */
  test('omitting the unique field rejects the write', async () => {
    const store = new MemoryStore({ 'post/a': { title: 'A', slug: 'a' } })
    const out = await write(store, 'PUT', 'post/a', { title: 'A2' })
    expect(out).toMatchObject({ status: 'rejected', reason: 'unique' })
  })
})

describe('MemoryStore implements the same contract as the Firestore adapter', () => {
  test('resolve handles collection/id and the field=value form', async () => {
    const store = new MemoryStore(
      { 'post/xyz': { slug: 'hello-world' } },
      { post: ['slug'] }
    )
    expect(await store.resolve('post/xyz')).toBe('post/xyz')
    expect(await store.resolve('post/slug=hello-world')).toBe('post/xyz')
  })

  test('field=value is refused for a field that is not an allowed key', async () => {
    // Matches getRef: only `unique`/`tagFields` may be used as lookup keys, so
    // the path form cannot be turned into an arbitrary query.
    const store = new MemoryStore({ 'post/xyz': { secret: 's' } }, { post: ['slug'] })
    const r = await store.resolve('post/secret=s')
    expect(r).toBeInstanceOf(Error)
    expect(String(r)).toContain('not an allowed key')
  })

  test('an odd-length path is rejected', async () => {
    const store = new MemoryStore()
    expect(await store.resolve('post')).toBeInstanceOf(Error)
  })

  test('a non-scalar unique value can never satisfy the constraint', async () => {
    const store = new MemoryStore()
    expect(await store.isUnique('post', 'slug', undefined, 'post/a')).toBe(false)
    expect(await store.isUnique('post', 'slug', { a: 1 }, 'post/a')).toBe(false)
    expect(await store.isUnique('post', 'slug', 'ok', 'post/a')).toBe(true)
  })

  test('stored documents are cloned, so callers cannot mutate the store', async () => {
    // A failure mode a real store does not have and a naive fake does.
    const store = new MemoryStore({ 'post/a': { tags: ['x'] } })
    const first = await store.get('post/a')
    ;(first.data.tags as string[]).push('injected')
    expect((await store.get('post/a')).data.tags).toEqual(['x'])
  })
})
