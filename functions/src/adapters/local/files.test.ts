/**
 * The directory Files adapter: what /blob and /stored rely on, and that no
 * key reaches outside its root.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { directoryFiles } from './files'
import type { FilesProvider } from '../../files'

let root = ''
let files: FilesProvider

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'directory-files-'))
  files = directoryFiles(join(root, 'files'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const bytes = (text: string) => new TextEncoder().encode(text)
const drain = (stream: NodeJS.ReadableStream) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (c) => chunks.push(Buffer.from(c)))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

describe('objects (/blob)', () => {
  test('put, head, read, hash', async () => {
    await files.objects.put(
      'blog:public/a/hello.txt@0123',
      bytes('hello'),
      'text/plain'
    )
    expect(await files.objects.head('blog:public/a/hello.txt@0123')).toEqual({
      bytes: 5,
      contentType: 'text/plain',
    })
    expect(
      await drain(files.objects.read('blog:public/a/hello.txt@0123'))
    ).toBe('hello')
    expect(await files.objects.hash('blog:public/a/hello.txt@0123')).toBe(
      createHash('sha256').update('hello').digest('hex')
    )
    // Files are files, at their keys.
    expect(
      readFileSync(
        join(root, 'files', 'blog:public', 'a', 'hello.txt@0123'),
        'utf8'
      )
    ).toBe('hello')
  })

  test('a missing object: head is null, read errors, hash rejects', async () => {
    expect(await files.objects.head('nope/x')).toBeNull()
    await expect(drain(files.objects.read('nope/x'))).rejects.toThrow()
    await expect(files.objects.hash('nope/x')).rejects.toThrow()
  })

  test('copy keeps bytes and type; delete removes both, and is idempotent', async () => {
    await files.objects.put('a/x', bytes('xx'), 'image/png')
    await files.objects.copy('a/x', 'b/y')
    expect(await files.objects.head('b/y')).toEqual({
      bytes: 2,
      contentType: 'image/png',
    })
    await files.objects.delete('a/x')
    await files.objects.delete('a/x')
    expect(await files.objects.head('a/x')).toBeNull()
    expect(existsSync(join(root, 'files', '.meta', 'a', 'x.json'))).toBe(false)
    expect(await files.objects.head('b/y')).not.toBeNull()
  })

  test('copying a missing object rejects', async () => {
    await expect(files.objects.copy('a/none', 'b/none')).rejects.toThrow()
  })

  test('nothing is signed: url is null, so the endpoint streams', async () => {
    await files.objects.put('a/x', bytes('x'), 'text/plain')
    expect(await files.objects.url('a/x', 60, 'text/plain')).toBeNull()
  })

  test('replacing an object replaces its bytes and type', async () => {
    await files.objects.put('a/x', bytes('first'), 'text/plain')
    await files.objects.put('a/x', bytes('2nd'), 'text/markdown')
    expect(await files.objects.head('a/x')).toEqual({
      bytes: 3,
      contentType: 'text/markdown',
    })
  })
})

describe('legacy (/stored)', () => {
  test('exists, content type, read; signing rejects so the reader streams', async () => {
    await files.objects.put('blog/pic.webp', bytes('img'), 'image/webp')
    expect(await files.legacy.exists('blog/pic.webp')).toBe(true)
    expect(await files.legacy.exists('blog/none.webp')).toBe(false)
    expect(await files.legacy.contentType('blog/pic.webp')).toBe('image/webp')
    expect(await drain(files.legacy.read('blog/pic.webp'))).toBe('img')
    await expect(
      files.legacy.signedReadUrl('blog/pic.webp', 1000)
    ).rejects.toThrow()
  })

  test('a file copied in by hand has no recorded type (the reader then goes by extension)', async () => {
    mkdirSync(join(root, 'files', 'public'), { recursive: true })
    writeFileSync(join(root, 'files', 'public', 'logo.png'), 'png')
    expect(await files.legacy.exists('public/logo.png')).toBe(true)
    expect(await files.legacy.contentType('public/logo.png')).toBeUndefined()
  })
})

describe('keys never leave the root', () => {
  const refused = [
    '../escape',
    'a/../../escape',
    '/etc/passwd',
    'a//b',
    '.meta/a/x.json',
    'a/.hidden',
    'a\0b',
    '',
  ]
  for (const key of refused) {
    test(`refuses ${JSON.stringify(key)}`, async () => {
      await expect(
        files.objects.put(key, bytes('x'), 'text/plain')
      ).rejects.toThrow('refused file key')
      expect(await files.objects.head(key)).toBeNull()
      await expect(files.objects.delete(key)).rejects.toThrow(
        'refused file key'
      )
      expect(await files.legacy.exists(key)).toBe(false)
      await expect(drain(files.objects.read(key))).rejects.toThrow(
        'refused file key'
      )
    })
  }
  test('nothing was written outside the root', async () => {
    for (const key of refused) {
await files.objects
        .put(key, bytes('x'), 'text/plain')
        .catch(() => undefined)
}
    expect(existsSync(join(root, 'escape'))).toBe(false)
  })
})
