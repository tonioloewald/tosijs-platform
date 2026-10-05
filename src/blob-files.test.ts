import { describe, expect, test } from 'bun:test'
import { cleanName, cleanPath, fileUrl, locate } from './blob-files'
import { cleanName as scriptCleanName } from '../scripts/sandbox-lib.js'
import { validateBlobPath } from '../functions/src/collections/blob'

describe('locate', () => {
  test('a folder with a colon is a storage area', () => {
    expect(locate('blog:public/a.png')).toEqual({
      area: 'blog:public',
      folder: 'blog:public',
      name: 'a.png',
    })
    expect(locate('/blog:public/sub/a.png')).toEqual({
      area: 'blog:public',
      folder: 'blog:public',
      name: 'sub/a.png',
    })
  })
  test('any other folder is legacy', () => {
    expect(locate('/public/a.png')).toEqual({
      area: null,
      folder: 'public',
      name: 'a.png',
    })
    expect(locate('blog')).toEqual({ area: null, folder: 'blog', name: '' })
  })
})

describe('fileUrl', () => {
  test('areas are served by /blob, legacy folders by /stored', () => {
    expect(fileUrl('blog:public/a.png')).toBe('/blob/blog:public/a.png')
    expect(fileUrl('/public/a.png')).toBe('/stored/public/a.png')
  })
})

describe('cleanName / cleanPath', () => {
  const names = [
    'Character Sheet.pdf',
    'caveman-with-VR-headset,-stalked-by-monster.webp',
    '.hidden',
    'trailing dots...',
    'ünïcödé name.png',
    '***',
    'ok-name_1.webp',
  ]
  test('agrees with the migration script, and /blob accepts the result', () => {
    for (const n of names) {
      expect(cleanName(n)).toBe(scriptCleanName(n))
      expect(validateBlobPath(cleanName(n))).toBeNull()
    }
  })
  test('cleanPath cleans each segment and drops empty ones', () => {
    expect(cleanPath('/my folder//Character Sheet.pdf')).toBe(
      'my-folder/Character-Sheet.pdf'
    )
    expect(validateBlobPath(cleanPath('a b/c d.png'))).toBeNull()
  })
})
