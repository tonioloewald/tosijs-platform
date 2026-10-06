import { describe, expect, test } from 'bun:test'
import { LOCAL_ONLY, collectionDir, exclusionReason, selectCollections } from './backup-lib.js'

// What production had on 2026-10-06.
const PROD = [
  'blog:public', 'cached-record', 'config', 'grant', 'install-log', 'manifest', 'module', 'page',
  'post', 'role', 'system:authorize', 'system:claim', 'system:install-proposal', 'system:registry',
  'system:render-log', 'system:render-r3', 'token',
]

describe('selectCollections', () => {
  const { backup, excluded } = selectCollections(PROD)

  test('backs up content, storage-area metadata and the host configuration', () => {
    expect(backup).toEqual([
      'blog:public', 'config', 'grant', 'install-log', 'manifest', 'module', 'page', 'post', 'role',
      'system:claim', 'system:registry', 'token',
    ])
  })

  test('leaves out only caches and short-lived requests, each with a reason', () => {
    expect(excluded.map((e) => e.name)).toEqual([
      'cached-record', 'system:authorize', 'system:install-proposal', 'system:render-log', 'system:render-r3',
    ])
    for (const e of excluded) expect(e.why.length).toBeGreaterThan(10)
  })

  test('a collection nobody has heard of is backed up', () => {
    expect(selectCollections(['virta:files', 'brand-new']).backup).toEqual(['brand-new', 'virta:files'])
  })

  test('a future render version is still a cache; a look-alike name is not', () => {
    expect(exclusionReason('system:render-r4')).not.toBeNull()
    expect(exclusionReason('system:registry')).toBeNull()
    expect(exclusionReason('cached-record-keeping')).toBeNull()
  })

  test('everything kept off-site-private is something that is backed up', () => {
    for (const name of Object.keys(LOCAL_ONLY)) expect(backup).toContain(name)
  })
})

describe('collectionDir', () => {
  test('never yields a path', () => {
    expect(collectionDir('blog:public')).toBe('blog:public')
    expect(collectionDir('..')).toBe('_..')
    expect(collectionDir('a/b')).toBe('a_b')
  })
})
