/**
 * Importing a backup snapshot into a local data directory (import-backup.ts),
 * against a small snapshot laid out as backup-firestore.js and
 * backup-storage.js write one.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { decode, importSnapshot } from './import-backup'
import { SqliteStore } from '../sqlite/store'

let root = ''
let snapshot = ''
let objects = ''
let data = ''

const md5 = (s: string) => createHash('md5').update(s).digest('hex')
function blob(content: string) {
  const hex = md5(content)
  mkdirSync(join(objects, hex.slice(0, 2)), { recursive: true })
  writeFileSync(join(objects, hex.slice(0, 2), hex), content)
  return hex
}
function doc(collection: string, id: string, body: unknown) {
  mkdirSync(join(snapshot, collection), { recursive: true })
  writeFileSync(join(snapshot, collection, `${id}.json`), JSON.stringify({ _id: id, _collection: collection, data: body }))
}
function manifest(extra: Record<string, unknown> = {}) {
  writeFileSync(
    join(snapshot, 'manifest.json'),
    JSON.stringify({
      complete: true,
      collections: [
        { name: 'post', count: 2 },
        { name: 'role', count: 1 },
      ],
      ...extra,
    })
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'import-backup-'))
  snapshot = join(root, 'backups', '2026-11-02T01-00-05Z')
  objects = join(root, 'backups', 'storage', 'objects')
  data = join(root, 'data')
  doc('post', 'a', { title: 'A', path: 'a', _created: '2026-01-01T00:00:00.000Z' })
  doc('post', 'b', { title: 'B', path: 'b', tags: ['x'] })
  doc('role', 'r', { roles: ['owner'], _created: { __type: 'timestamp', value: '2024-06-19T09:55:30.143Z' } })
  manifest()
  writeFileSync(
    join(snapshot, 'storage.json'),
    JSON.stringify({
      objects: [
        { name: 'blog/', md5: md5(''), size: 0 },
        { name: 'blog/pic.webp', md5: blob('webp-bytes'), contentType: 'image/webp' },
        { name: 'blog:public/x.txt@0123', md5: blob('text'), contentType: 'text/plain' },
        { name: 'blog/gone.png', md5: md5('never stored'), contentType: 'image/png' },
        { name: 'blog/.hidden', md5: blob('hidden'), contentType: 'text/plain' },
      ],
    })
  )
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('documents and files land in the data directory', async () => {
  const result = await importSnapshot({ snapshot, dataDir: data })
  expect(result.documents).toEqual({ post: 2, role: 1 })
  expect(result.files).toBe(2)
  expect(result.missingFiles).toEqual(['blog/gone.png'])
  expect(result.refusedFiles).toEqual(['blog/.hidden'])

  const store = new SqliteStore(join(data, 'host.db'))
  try {
    expect((await store.get('post/b')).data).toEqual({ title: 'B', path: 'b', tags: ['x'] })
    // A Firestore timestamp becomes its ISO string, as restore-firestore.js decodes it.
    expect((await store.get('role/r')).data._created).toBe('2024-06-19T09:55:30.143Z')
  } finally {
    store.close()
  }
  expect(readFileSync(join(data, 'files', 'blog', 'pic.webp'), 'utf8')).toBe('webp-bytes')
  expect(JSON.parse(readFileSync(join(data, 'files', '.meta', 'blog', 'pic.webp.json'), 'utf8'))).toEqual({
    contentType: 'image/webp',
  })
  // The folder marker is not a file, and the backup is untouched.
  expect(existsSync(join(data, 'files', 'blog', '.json'))).toBe(false)
  expect(existsSync(join(snapshot, 'post', 'a.json'))).toBe(true)
})

test('a damaged object stops the import', async () => {
  const hex = md5('webp-bytes')
  writeFileSync(join(objects, hex.slice(0, 2), hex), 'bit rot')
  await expect(importSnapshot({ snapshot, dataDir: data })).rejects.toThrow('does not match its md5')
  // Cleaned up, so fixing the backup and re-running works.
  expect(existsSync(join(data, 'host.db'))).toBe(false)
  expect(existsSync(join(data, 'files'))).toBe(false)
})

test('never imports into a host that already has data', async () => {
  await importSnapshot({ snapshot, dataDir: data })
  await expect(importSnapshot({ snapshot, dataDir: data })).rejects.toThrow('empty data directory')
})

test('refuses a partial snapshot', async () => {
  manifest({ complete: false })
  await expect(importSnapshot({ snapshot, dataDir: data })).rejects.toThrow('partial')
  expect(existsSync(join(data, 'host.db'))).toBe(false)
})

describe('decode', () => {
  test('tagged values become their plain form; anything else is unchanged', () => {
    expect(decode({ a: [{ __type: 'bytes', value: 'AA==' }], b: { c: 1 } })).toEqual({ a: ['AA=='], b: { c: 1 } })
  })
  test('an unknown tag is an error, not silently kept', () => {
    expect(() => decode({ __type: 'vector', value: [] })).toThrow('unknown tagged type')
  })
})
