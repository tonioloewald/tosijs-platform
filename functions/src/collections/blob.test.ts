/**
 * Blob storage decisions (#1136 step 1) — a storage area is a collection.
 */
import { describe, test, expect } from 'bun:test'
import { ALL, type CollectionMap } from './access'
import { ROLES, anonymousUser, type UserRoles } from './roles'
import {
  blobDocId,
  blobPathFromDocId,
  contentTypeAllowed,
  decideDelete,
  decideMove,
  decidePut,
  decideRead,
  isBlobStore,
  isPublicArea,
  validateBlobPath,
  type BlobMeta,
} from './blob'

const who = (roles: string[]): UserRoles =>
  ({ name: 'x', contacts: [], roles, userIds: ['u1'] }) as never

const areas: CollectionMap = {
  // The blog's two classes (owner, 2026-09-28).
  'blog:public': {
    blob: { maxBytes: 5_000_000, contentTypes: ['image/*', 'audio/mpeg', 'video/mp4'] },
    access: {
      [ROLES.public]: { read: ALL, list: ALL },
      [ROLES.author]: { write: ALL },
    },
  },
  'blog:private': {
    blob: { maxBytes: 1_000_000 },
    access: {
      [ROLES.author]: { read: ALL, list: ALL, write: ALL },
    },
  },
  // Readable only when the metadata is tagged — a visibility FILTER.
  'lib:tagged': {
    blob: { maxBytes: 1000 },
    access: {
      [ROLES.public]: {
        read: async (row: Record<string, unknown>) =>
          (row.tags as string[] | undefined)?.includes('public') ? row : new Error('no'),
      },
      [ROLES.admin]: { write: { path: ALL } as never },
    },
  },
  // An ordinary collection is NOT a storage area.
  post: { access: { [ROLES.public]: { read: ALL } } },
}

const meta: BlobMeta = {
  path: 'covers/a.webp',
  contentType: 'image/webp',
  bytes: 100,
  sha256: 'a'.repeat(64),
}
const put = (over: Record<string, unknown> = {}) => ({
  path: 'covers/a.webp',
  contentType: 'image/webp',
  bytes: 100,
  sha256: 'a'.repeat(64),
  ...over,
})

describe('a storage area is a collection with `blob` limits', () => {
  test('recognised by its config, nothing else', () => {
    expect(isBlobStore(areas['blog:public'])).toBe(true)
    expect(isBlobStore(areas.post)).toBe(false)
    expect(isBlobStore(undefined)).toBe(false)
  })
})

describe('public vs private is DERIVED from the access rules', () => {
  test('anonymous unconditional read → public', () => {
    expect(isPublicArea(areas, 'blog:public')).toBe(true)
  })
  test('signed-in read, or a visibility filter → private', () => {
    expect(isPublicArea(areas, 'blog:private')).toBe(false)
    expect(isPublicArea(areas, 'lib:tagged')).toBe(false)
  })
  test('an ordinary public collection is not a public AREA', () => {
    expect(isPublicArea(areas, 'post')).toBe(false)
  })
})

describe('decideRead — how (and whether) a file is delivered', () => {
  test('public area → the stable URL, for anyone', async () => {
    expect(await decideRead(areas, 'blog:public', meta, anonymousUser)).toEqual({ status: 'public' })
  })
  test('private area → a short-lived signed link, only for a reader', async () => {
    expect(await decideRead(areas, 'blog:private', meta, who([ROLES.author]))).toMatchObject({
      status: 'signed',
    })
    expect(await decideRead(areas, 'blog:private', meta, anonymousUser)).toMatchObject({
      status: 'refused',
      reason: 'forbidden',
    })
  })
  test('a visibility filter is evaluated against the METADATA document', async () => {
    const tagged = { ...meta, tags: ['public'] }
    expect(await decideRead(areas, 'lib:tagged', tagged, anonymousUser)).toMatchObject({ status: 'signed' })
    expect(await decideRead(areas, 'lib:tagged', meta, anonymousUser)).toMatchObject({ status: 'refused' })
  })
  test('not a storage area → refused, opaquely', async () => {
    expect(await decideRead(areas, 'post', meta, anonymousUser)).toMatchObject({
      status: 'refused',
      message: 'not found',
    })
  })
})

describe('decidePut', () => {
  test('an author may store an accepted image', () => {
    const d = decidePut(areas, 'blog:public', put(), who([ROLES.author]))
    expect(d).toEqual({ status: 'allowed', meta })
  })
  test('without write access → forbidden (answered opaquely)', () => {
    expect(decidePut(areas, 'blog:public', put(), anonymousUser)).toMatchObject({ reason: 'forbidden' })
    expect(decidePut(areas, 'blog:public', put(), who([]))).toMatchObject({ reason: 'forbidden' })
  })
  test('a FILTER write grant fails closed, as for collections (review F1)', () => {
    expect(decidePut(areas, 'lib:tagged', put({ bytes: 10 }), who([ROLES.admin]))).toMatchObject({
      reason: 'forbidden',
    })
  })
  test('over the limit → too-large', () => {
    expect(decidePut(areas, 'blog:private', put({ bytes: 1_000_001 }), who([ROLES.author]))).toMatchObject({
      reason: 'too-large',
    })
  })
  test('a type outside the list → type; families and parameters handled', () => {
    const author = who([ROLES.author])
    expect(decidePut(areas, 'blog:public', put({ contentType: 'application/pdf' }), author)).toMatchObject({
      reason: 'type',
    })
    expect(decidePut(areas, 'blog:public', put({ contentType: 'IMAGE/PNG; charset=x' }), author)).toMatchObject({
      status: 'allowed',
      meta: { contentType: 'image/png' },
    })
  })
  test('malformed requests are refused, never guessed', () => {
    const author = who([ROLES.author])
    for (const bad of [
      { contentType: 'nonsense' },
      { bytes: -1 },
      { bytes: 1.5 },
      { sha256: 'short' },
      { sha256: 'A'.repeat(64) },
    ]) {
      expect(decidePut(areas, 'blog:public', put(bad), author).status).toBe('refused')
    }
  })
  test('dimensions are kept only when they are positive integers', () => {
    const d = decidePut(areas, 'blog:public', put({ width: 800, height: 0 }), who([ROLES.author]))
    expect(d).toMatchObject({ status: 'allowed', meta: { width: 800 } })
    expect('height' in (d as { meta: object }).meta).toBe(false)
  })
})

describe('paths are narrow on purpose — a key AND a URL', () => {
  test('ordinary nested paths pass', () => {
    for (const p of ['a.webp', '2026/09/cover.webp', 'podcast/ep-01_final.mp3']) {
      expect(validateBlobPath(p)).toBeNull()
    }
  })
  test('traversal, hidden files, empty segments and escapes are refused', () => {
    for (const p of ['', '../x', 'a/../b', '.env', 'a//b', '/abs', 'a/', 'sp ace.png', 'a~b', 'é.png', 'x'.repeat(513)]) {
      expect(validateBlobPath(p)).not.toBeNull()
    }
  })
  test('doc id mapping is one-to-one and reversible', () => {
    expect(blobDocId('2026/09/a.webp')).toBe('2026~09~a.webp')
    expect(blobPathFromDocId(blobDocId('2026/09/a.webp'))).toBe('2026/09/a.webp')
  })
})

describe('content-type patterns', () => {
  test('exact, family, and absent-means-any', () => {
    expect(contentTypeAllowed('image/png', ['image/*'])).toBe(true)
    expect(contentTypeAllowed('imagex/png', ['image/*'])).toBe(false)
    expect(contentTypeAllowed('audio/mpeg', ['audio/mpeg'])).toBe(true)
    expect(contentTypeAllowed('anything/at-all')).toBe(true)
  })
})

describe('delete and move', () => {
  test('delete needs unconditional write access and a valid path', () => {
    expect(decideDelete(areas, 'blog:public', 'a.webp', who([ROLES.author]))).toEqual({ status: 'allowed' })
    expect(decideDelete(areas, 'blog:public', 'a.webp', anonymousUser)).toMatchObject({ reason: 'forbidden' })
    expect(decideDelete(areas, 'blog:public', '../x', who([ROLES.author]))).toMatchObject({ reason: 'path' })
  })
  test('a move needs delete at the source AND put at the destination, with its limits', () => {
    const author = who([ROLES.author])
    expect(
      decideMove(areas, { area: 'blog:public', path: 'a.webp' }, { area: 'blog:public', path: 'b.webp' }, meta, author)
    ).toMatchObject({ status: 'allowed', meta: { path: 'b.webp' } })
    // Into a smaller area: refused exactly as uploading there would be.
    const big = { ...meta, bytes: 2_000_000 }
    expect(
      decideMove(areas, { area: 'blog:public', path: 'a.webp' }, { area: 'blog:private', path: 'a.webp' }, big, author)
    ).toMatchObject({ reason: 'too-large' })
  })
})
