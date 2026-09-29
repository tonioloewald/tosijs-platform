/**
 * /blob handler (#1136 step 2) against in-memory fakes — every route, and the
 * orderings that keep metadata and bytes consistent when something fails.
 */
import { describe, test, expect } from 'bun:test'
import { createHash } from 'crypto'
import { ALL, type CollectionMap } from './collections/access'
import { ROLES, anonymousUser, type UserRoles } from './collections/roles'
import type { BlobMeta } from './collections/blob'
import { deliveryHeaders, handleBlob, objectKey, parseBlobRoute, type BlobDeps } from './blob-handler'
import type { CommitOutcome } from './commit'

const who = (roles: string[]): UserRoles =>
  ({ name: 'x', contacts: [], roles, userIds: ['u1'] }) as never
const author = who([ROLES.author])

const areas: CollectionMap = {
  'blog:public': {
    blob: { maxBytes: 1000, contentTypes: ['image/*', 'text/plain'] },
    access: { [ROLES.public]: { read: ALL, list: ALL }, [ROLES.author]: { write: ALL } },
  },
  'blog:private': {
    blob: { maxBytes: 1000 },
    access: { [ROLES.author]: { read: ALL, list: ALL, write: ALL } },
  },
  'log:frozen': {
    blob: { maxBytes: 1000 },
    immutable: true,
    access: { [ROLES.author]: { read: ALL, write: ALL } },
  },
}

function fakes(opts: { canSign?: boolean; commitRefuses?: boolean; commitThrows?: boolean } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>()
  const metas = new Map<string, BlobMeta & Record<string, unknown>>()
  const deps: BlobDeps = {
    collectionsFor: async () => areas,
    getMeta: async (p) => metas.get(p) ?? null,
    commitMeta: async (p, meta): Promise<CommitOutcome> => {
      if (opts.commitThrows) throw new Error('store down')
      if (opts.commitRefuses) {
        return { status: 'refused', refusal: { p, reason: 'schema', message: 'nope' } }
      }
      metas.set(p, { ...meta, _by: { uid: 'u1' } })
      return { status: 'committed', out: [{ p }] }
    },
    deleteMeta: async (p) => void metas.delete(p),
    objects: {
      put: async (k, bytes, contentType) => void objects.set(k, { bytes, contentType }),
      delete: async (k) => void objects.delete(k),
      copy: async (from, to) => {
        const o = objects.get(from)
        if (!o) throw new Error(`no ${from}`)
        objects.set(to, o)
      },
      url: async (k, ttl) => (opts.canSign === false ? null : `https://signed/${k}?ttl=${ttl}`),
    },
    sha256: (b) => createHash('sha256').update(b).digest('hex'),
    isPrivileged: (r) => r.roles.includes(ROLES.admin as never),
  }
  return { deps, objects, metas }
}

const bytes = (s: string) => new TextEncoder().encode(s)
/** A value the test just stored; failing loudly beats a non-null assertion. */
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected a stored value')
  return v
}
const putReq = (pathname: string, body: string, contentType = 'text/plain', userRoles = author) => ({
  method: 'PUT',
  pathname,
  body: bytes(body),
  contentType,
  userRoles,
})

describe('routes', () => {
  test('/blob/<area>/<path> parses, with or without the /blob prefix', () => {
    expect(parseBlobRoute('/blob/blog:public/a/b.png')).toEqual({ area: 'blog:public', path: 'a/b.png' })
    expect(parseBlobRoute('/blog:public/a.png')).toEqual({ area: 'blog:public', path: 'a.png' })
    expect(parseBlobRoute('/nonamespace/a.png')).toBeNull()
    expect(parseBlobRoute('/blog:public')).toBeNull()
  })
})

describe('PUT', () => {
  test('stores bytes under a content-hashed key, then the metadata — size and hash MEASURED', async () => {
    const { deps, objects, metas } = fakes()
    const r = await handleBlob(putReq('/blob/blog:public/hello.txt', 'hi'), deps)
    expect(r).toMatchObject({ kind: 'json', status: 200, body: { status: 'stored', bytes: 2 } })
    const meta = metas.get('blog:public/hello.txt')
    expect(meta).toMatchObject({ path: 'hello.txt', contentType: 'text/plain', bytes: 2 })
    expect(objects.has(objectKey('blog:public', 'hello.txt', must(meta).sha256))).toBe(true)
  })

  test('an identical re-upload is unchanged; a replace swaps keys and deletes the OLD object after the commit', async () => {
    const { deps, objects, metas } = fakes()
    await handleBlob(putReq('/blob/blog:public/a.txt', 'one'), deps)
    const first = must(metas.get('blog:public/a.txt')).sha256
    expect(await handleBlob(putReq('/blob/blog:public/a.txt', 'one'), deps)).toMatchObject({
      body: { status: 'unchanged' },
    })
    await handleBlob(putReq('/blob/blog:public/a.txt', 'two'), deps)
    const second = must(metas.get('blog:public/a.txt')).sha256
    expect(second).not.toBe(first)
    expect(objects.has(objectKey('blog:public', 'a.txt', first))).toBe(false)
    expect(objects.has(objectKey('blog:public', 'a.txt', second))).toBe(true)
  })

  test('a refused or failed metadata commit deletes the new object — no file without a document', async () => {
    for (const opt of [{ commitRefuses: true }, { commitThrows: true }]) {
      const { deps, objects, metas } = fakes(opt)
      const r = await handleBlob(putReq('/blob/blog:public/x.txt', 'data'), deps).catch((e) => e)
      if (!(r instanceof Error)) expect(r).toMatchObject({ kind: 'error' })
      expect(objects.size).toBe(0)
      expect(metas.size).toBe(0)
    }
  })

  test('a failed REPLACE keeps the old file intact and referenced', async () => {
    const good = fakes()
    await handleBlob(putReq('/blob/blog:public/k.txt', 'old'), good.deps)
    const oldSha = must(good.metas.get('blog:public/k.txt')).sha256
    // Now the commit starts refusing: the replace must not disturb the old file.
    good.deps.commitMeta = async (p) => ({ status: 'refused', refusal: { p, reason: 'schema', message: 'x' } })
    await handleBlob(putReq('/blob/blog:public/k.txt', 'new'), good.deps)
    expect(must(good.metas.get('blog:public/k.txt')).sha256).toBe(oldSha)
    expect(good.objects.has(objectKey('blog:public', 'k.txt', oldSha))).toBe(true)
    expect(good.objects.size).toBe(1)
  })

  test('limits: too large → 413 too-large; wrong type → 415 unsupported-type', async () => {
    const { deps } = fakes()
    expect(await handleBlob(putReq('/blob/blog:public/big.txt', 'x'.repeat(1001)), deps)).toMatchObject({
      status: 413,
      error: 'too-large',
    })
    expect(await handleBlob(putReq('/blob/blog:public/a.pdf', 'x', 'application/pdf'), deps)).toMatchObject({
      status: 415,
      error: 'unsupported-type',
    })
  })

  test('no write access → the opaque 404 for a non-privileged caller', async () => {
    const { deps } = fakes()
    expect(await handleBlob(putReq('/blob/blog:public/a.txt', 'x', 'text/plain', anonymousUser), deps)).toMatchObject({
      status: 404,
      error: 'not-found',
    })
  })

  test('an immutable area refuses a replace (409) but accepts an identical re-upload', async () => {
    const { deps } = fakes()
    await handleBlob(putReq('/blob/log:frozen/e1', 'event'), deps)
    expect(await handleBlob(putReq('/blob/log:frozen/e1', 'event'), deps)).toMatchObject({ body: { status: 'unchanged' } })
    expect(await handleBlob(putReq('/blob/log:frozen/e1', 'changed'), deps)).toMatchObject({ status: 409, error: 'immutable' })
  })
})

describe('GET', () => {
  test('a public file redirects with a CACHEABLE response', async () => {
    const { deps } = fakes()
    await handleBlob(putReq('/blob/blog:public/p.txt', 'pub'), deps)
    const r = await handleBlob({ method: 'GET', pathname: '/blob/blog:public/p.txt', userRoles: anonymousUser }, deps)
    expect(r).toMatchObject({ kind: 'redirect', cacheControl: expect.stringContaining('public') })
  })

  test('a private file: a short signed link for a reader, never cached; opaque 404 for anyone else', async () => {
    const { deps } = fakes()
    await handleBlob(putReq('/blob/blog:private/s.txt', 'secret'), deps)
    const reader = await handleBlob({ method: 'GET', pathname: '/blob/blog:private/s.txt', userRoles: author }, deps)
    expect(reader).toMatchObject({ kind: 'redirect', cacheControl: 'private, no-store' })
    expect((reader as { url: string }).url).toContain('ttl=300')
    const stranger = await handleBlob({ method: 'GET', pathname: '/blob/blog:private/s.txt', userRoles: anonymousUser }, deps)
    expect(stranger).toMatchObject({ status: 404, error: 'not-found' })
  })

  test('a substrate that cannot sign (the emulator) streams instead', async () => {
    const { deps } = fakes({ canSign: false })
    await handleBlob(putReq('/blob/blog:public/e.txt', 'x'), deps)
    const r = await handleBlob({ method: 'GET', pathname: '/blob/blog:public/e.txt', userRoles: anonymousUser }, deps)
    expect(r).toMatchObject({ kind: 'stream', contentType: 'text/plain', headers: { 'X-Content-Type-Options': 'nosniff' } })
  })

  test('streamed bytes come from the SITE origin: never sniffed, and script-capable types are sandboxed', () => {
    expect(deliveryHeaders('image/png')).toEqual({ 'X-Content-Type-Options': 'nosniff' })
    expect(deliveryHeaders('application/pdf')['Content-Security-Policy']).toBeUndefined()
    for (const t of ['image/svg+xml', 'IMAGE/SVG+XML', 'text/html; charset=utf-8', 'application/xhtml+xml', 'text/xml']) {
      expect(deliveryHeaders(t)['Content-Security-Policy']).toStartWith('sandbox;')
    }
  })

  test('missing file, bad path, or not an area → the same opaque 404', async () => {
    const { deps } = fakes()
    for (const pathname of ['/blob/blog:public/nope.txt', '/blob/blog:public/../x', '/blob/other:thing/a.txt']) {
      expect(await handleBlob({ method: 'GET', pathname, userRoles: anonymousUser }, deps)).toMatchObject({ status: 404 })
    }
  })
})

describe('DELETE', () => {
  test('metadata first, then the object', async () => {
    const { deps, objects, metas } = fakes()
    await handleBlob(putReq('/blob/blog:public/d.txt', 'bye'), deps)
    expect(await handleBlob({ method: 'DELETE', pathname: '/blob/blog:public/d.txt', userRoles: author }, deps)).toMatchObject({
      body: { status: 'deleted' },
    })
    expect(metas.size).toBe(0)
    expect(objects.size).toBe(0)
  })

  test('an immutable area refuses deletes', async () => {
    const { deps } = fakes()
    await handleBlob(putReq('/blob/log:frozen/e2', 'event'), deps)
    expect(await handleBlob({ method: 'DELETE', pathname: '/blob/log:frozen/e2', userRoles: author }, deps)).toMatchObject({
      status: 409,
      error: 'immutable',
    })
  })
})

describe('MOVE', () => {
  const move = (from: string, to: string, fromArea = 'blog:public', toArea = 'blog:public') => ({
    method: 'POST',
    pathname: '/blob',
    json: { op: 'move', from: { area: fromArea, path: from }, to: { area: toArea, path: to } },
    userRoles: author,
  })

  test('copies, commits the destination, THEN removes the source', async () => {
    const { deps, objects, metas } = fakes()
    await handleBlob(putReq('/blob/blog:public/a.txt', 'move me'), deps)
    const sha = must(metas.get('blog:public/a.txt')).sha256
    expect(await handleBlob(move('a.txt', 'b.txt'), deps)).toMatchObject({ body: { status: 'moved' } })
    expect(metas.has('blog:public/a.txt')).toBe(false)
    expect(metas.get('blog:public/b.txt')).toMatchObject({ path: 'b.txt', sha256: sha })
    expect([...objects.keys()]).toEqual([objectKey('blog:public', 'b.txt', sha)])
  })

  test('never clobbers an occupied destination', async () => {
    const { deps } = fakes()
    await handleBlob(putReq('/blob/blog:public/a.txt', 'one'), deps)
    await handleBlob(putReq('/blob/blog:public/b.txt', 'two'), deps)
    expect(await handleBlob(move('a.txt', 'b.txt'), deps)).toMatchObject({ status: 403, error: 'exists' })
  })

  test('the destination\'s limits apply', async () => {
    const { deps } = fakes()
    await handleBlob(putReq('/blob/blog:public/i.txt', 'x'), deps)
    // blog:private has no type list but the same size limit; move a type the
    // public area accepts into it: allowed. Into a public path with a bad
    // type is impossible here, so check the size rule with a big file.
    const big = fakes()
    big.metas.set('blog:private/big', { path: 'big', contentType: 'text/plain', bytes: 5000, sha256: 'a'.repeat(64) })
    const r = await handleBlob(move('big', 'big2', 'blog:private', 'blog:public'), big.deps)
    expect(r).toMatchObject({ status: 413, error: 'too-large' })
  })
})
