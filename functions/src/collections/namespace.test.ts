/**
 * Namespacing rules (tosijs-platform#5, #7).
 *
 * The important assertions here are the REFUSALS. This module is the gate that
 * keeps one installed library out of another library's collections and out of
 * the platform's — and `role` and `module` are not ordinary collections:
 * whoever writes `role` rewrites the input to their own authorization (D4), and
 * `module` documents are served as executable JavaScript by `/esm`. A namespace
 * check that lets a manifest claim either is a site takeover, not a name clash.
 *
 * Run: cd functions && bun test src/collections/namespace.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import {
  parseCollection,
  refuseDeclaration,
  isPlatformCollection,
  isReservedCollection,
  physicalCollection,
  physicalPath,
  PLATFORM_COLLECTIONS,
  NAMESPACE_SEPARATOR,
} from './namespace'
import { collectionPath } from './access'

describe('the separator does not collide with path parsing', () => {
  test('it is not "/"', () => {
    // The whole reason for `:`. `/` is already the sub-collection separator.
    expect(NAMESPACE_SEPARATOR).not.toBe('/')
  })

  test('collectionPath still works on a namespaced document path', () => {
    // Unchanged behaviour is the point: `:` rides inside one segment.
    expect(collectionPath('virta:task/abc')).toBe('virta:task')
    expect(collectionPath('virta:task/abc/comment/xyz')).toBe(
      'virta:task/comment'
    )
  })

  test('a "/" separator WOULD have collided (why this is not hypothetical)', () => {
    // `virta/task` parses as collection `virta`, document `task` — a valid
    // two-segment path meaning something entirely different.
    expect(collectionPath('virta/task')).toBe('virta')
  })
})

describe('parseCollection', () => {
  test('a bare name is a platform collection', () => {
    expect(parseCollection('post')).toEqual({
      namespace: null,
      name: 'post',
      logical: 'post',
    })
    expect(isPlatformCollection('post')).toBe(true)
    expect(isPlatformCollection('virta:task')).toBe(false)
  })

  test('a namespaced name splits', () => {
    expect(parseCollection('virta:task')).toMatchObject({
      namespace: 'virta',
      name: 'task',
    })
  })

  test('namespaces do not nest', () => {
    expect(parseCollection('a:b:c')).toBeInstanceOf(Error)
  })

  test('a document path is refused — callers must split on "/" first', () => {
    const r = parseCollection('virta:task/abc')
    expect(r).toBeInstanceOf(Error)
    expect(String(r)).toContain('split on')
  })

  test('invalid namespaces and names are refused', () => {
    for (const bad of ['A:task', '1virta:task', '-v:task', 'v:task', ':task']) {
      expect(parseCollection(bad)).toBeInstanceOf(Error)
    }
    for (const bad of ['virta:Task', 'virta:1task', 'virta:']) {
      expect(parseCollection(bad)).toBeInstanceOf(Error)
    }
  })

  test('a two-character namespace is allowed, one is not', () => {
    // Pattern is `[a-z][a-z0-9-]{1,31}`: a leading letter plus 1-31 more.
    expect(parseCollection('ab:task')).not.toBeInstanceOf(Error)
    expect(parseCollection('a:task')).toBeInstanceOf(Error)
  })
})

describe('refuseDeclaration — the gate', () => {
  test('a manifest may declare its own namespace', () => {
    expect(refuseDeclaration('virta', 'virta:task')).toBeNull()
    expect(refuseDeclaration('virta', 'virta:event')).toBeNull()
  })

  test('a manifest may NOT declare another namespace', () => {
    const r = refuseDeclaration('virta', 'blog:post')
    expect(r).toBeInstanceOf(Error)
    expect(String(r)).toContain('belongs to "blog"')
  })

  test('a manifest may NOT declare any bare name', () => {
    for (const name of PLATFORM_COLLECTIONS) {
      expect(refuseDeclaration('virta', name)).toBeInstanceOf(Error)
    }
  })

  test('the crown jewels specifically are refused', () => {
    // `role` decides who the RBAC check sees; `module` is executable JS via
    // /esm. Either one claimed by a manifest is a takeover.
    for (const name of ['role', 'module']) {
      const r = refuseDeclaration('virta', name)
      expect(r).toBeInstanceOf(Error)
      expect(String(r)).toContain('platform collection')
    }
  })

  test('an UNKNOWN bare name is refused too, not just the known list', () => {
    // The rule is "installed collections must be namespaced", not "avoid this
    // list" — otherwise every new platform collection would need a code change
    // here to stay safe.
    const r = refuseDeclaration('virta', 'tasks')
    expect(r).toBeInstanceOf(Error)
    expect(String(r)).toContain('un-namespaced')
  })

  test('a manifest with an invalid namespace declares nothing', () => {
    expect(refuseDeclaration('Virta', 'Virta:task')).toBeInstanceOf(Error)
  })

  test('near-miss namespaces do not match', () => {
    // Substring/prefix confusion is the classic way a check like this leaks.
    expect(refuseDeclaration('virta', 'virta2:task')).toBeInstanceOf(Error)
    expect(refuseDeclaration('virta2', 'virta:task')).toBeInstanceOf(Error)
  })
})

describe('logical to physical mapping', () => {
  test('is the identity today, so stored data is untouched', () => {
    expect(physicalCollection('post')).toBe('post')
    expect(physicalCollection('virta:task')).toBe('virta:task')
  })

  test('physicalPath maps collection segments and leaves document ids alone', () => {
    expect(physicalPath('virta:task/abc')).toBe('virta:task/abc')
    expect(physicalPath('virta:task/abc/comment/xyz')).toBe(
      'virta:task/abc/comment/xyz'
    )
  })

  test('a document id containing the separator is NOT mangled', () => {
    // Ids are opaque; only even segments are collections.
    expect(physicalPath('post/a:b')).toBe('post/a:b')
  })
})

describe('Firestore collection id legality', () => {
  test('a namespaced name breaks none of the documented rules', () => {
    const id = physicalCollection('virta:task')
    expect(id).not.toContain('/')
    expect(id).not.toBe('.')
    expect(id).not.toBe('..')
    expect(id).not.toMatch(/^__.*__$/)
    expect(Buffer.byteLength(id, 'utf-8')).toBeLessThanOrEqual(1500)
  })

  test('it needs no URL encoding in a query string', () => {
    expect(encodeURIComponent('virta:task')).toBe('virta%3Atask')
    // …but a raw `:` is legal in a query value, which is what /doc?p= receives.
    const parsed = new URL('https://x/doc?p=virta:task/abc')
    expect(parsed.searchParams.get('p')).toBe('virta:task/abc')
  })
})

describe('reserved namespaces (M2, 0.2.0-beta.3 review)', () => {
  test('no manifest may take the "system" namespace', () => {
    expect(refuseDeclaration('system', 'system:claim')?.message).toContain('reserved')
    expect(refuseDeclaration('system', 'system:anything')?.message).toContain('reserved')
  })

  test('isReservedCollection recognises system:* and nothing else', () => {
    expect(isReservedCollection('system:claim')).toBe(true)
    expect(isReservedCollection('system:host')).toBe(true)
    expect(isReservedCollection('virta:task')).toBe(false)
    // A bare name is the platform's by a different rule.
    expect(isReservedCollection('system')).toBe(false)
    expect(isReservedCollection('systems:x')).toBe(false)
  })
})
