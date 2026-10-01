import { describe, test, expect } from 'bun:test'
import { legacyObjectPath, storedObjectPath } from './legacy-storage'
import { objectKey } from './blob-handler'

describe('legacyObjectPath — what the legacy readers may touch', () => {
  test('files in the legacy folders, decoded', () => {
    expect(legacyObjectPath('blog/Harris-2024.jpeg')).toBe('blog/Harris-2024.jpeg')
    expect(legacyObjectPath('blog/Character%20Sheet.pdf')).toBe('blog/Character Sheet.pdf')
    expect(legacyObjectPath('public/tosi-platform.json')).toBe('public/tosi-platform.json')
    expect(legacyObjectPath('users/u1/a.png')).toBe('users/u1/a.png')
  })

  test('NEVER a storage area object — raw or encoded', () => {
    const key = objectKey('blog:private', 'secret.txt', 'a'.repeat(64))
    expect(legacyObjectPath(key)).toBeNull()
    expect(legacyObjectPath(encodeURIComponent(key))).toBeNull()
    expect(legacyObjectPath('blog%3Aprivate/secret.txt@aaaa')).toBeNull()
  })

  test('nothing outside the folders, no traversal, no junk', () => {
    for (const p of ['secret.txt', 'other/x', 'blog', 'blog/', 'blog/../x', 'blog/./x', 'blog//x', '%E0', '/blog/x', 'blog%2F..%2Fx']) {
      expect(legacyObjectPath(p)).toBeNull()
    }
  })
})

describe('storedObjectPath — the object a /stored URL names', () => {
  test('the query string and fragment are not part of the name', () => {
    expect(storedObjectPath('/stored/blog/Harris-2024.jpeg?t=123')).toBe('blog/Harris-2024.jpeg')
    expect(storedObjectPath('/stored/blog/a.png#top')).toBe('blog/a.png')
    expect(storedObjectPath('/stored/blog/Character%20Sheet.pdf?v=2')).toBe('blog/Character Sheet.pdf')
  })
  test('still refuses what legacyObjectPath refuses, and non-/stored URLs', () => {
    expect(storedObjectPath('/stored/blog:private/x@aaaa?t=1')).toBeNull()
    expect(storedObjectPath('/elsewhere/blog/a.png')).toBeNull()
    expect(storedObjectPath(undefined)).toBeNull()
  })
})

