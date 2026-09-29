/**
 * The checked-in `manifests/blog.json` — the blog's storage areas (#1136 step
 * 3) — must stay a manifest the installer accepts, and must grant what
 * `storage.rules` grants for `blog/` today: anyone reads, the content roles
 * write. Roles do not inherit, so each content role is named; this pins that.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { unenforcedKeywords } from 'tosijs-schema'
import { validateManifest, type Manifest } from './manifest'
import { compileManifest } from './compile'
import { ROLES, anonymousUser, type RoleName, type UserRoles } from '../collections/roles'
import { decidePut, isPublicArea } from '../collections/blob'
import type { CollectionMap } from '../collections/access'

const manifest = JSON.parse(
  readFileSync(new URL('../../../manifests/blog.json', import.meta.url), 'utf-8')
) as Manifest
const opts = {
  unenforced: (s: Record<string, unknown>) => unenforcedKeywords(s as never) as string[],
  knownRoles: Object.values(ROLES),
}
const who = (roles: RoleName[]): UserRoles => ({ ...anonymousUser, roles, principal: { uid: 'u1' } } as UserRoles)
const file = (contentType: string) => ({ path: 'a/b.png', contentType, bytes: 10, sha256: 'a'.repeat(64) })

describe('manifests/blog.json', () => {
  test('is a manifest the installer accepts', () => {
    expect(validateManifest(manifest, opts)).toEqual([])
  })

  const collections = compileManifest(manifest) as CollectionMap

  test('blog:public is public, blog:private is not', async () => {
    expect(await isPublicArea(collections, 'blog:public')).toBe(true)
    expect(await isPublicArea(collections, 'blog:private')).toBe(false)
  })

  test('every content role may write both areas (as storage.rules allowed for blog/)', () => {
    for (const role of [ROLES.author, ROLES.editor, ROLES.admin, ROLES.developer, ROLES.owner] as RoleName[]) {
      for (const area of ['blog:public', 'blog:private']) {
        expect(decidePut(collections, area, file('image/png'), who([role])).status).toBe('allowed')
      }
    }
  })

  test('nobody else may', () => {
    for (const u of [anonymousUser, who([ROLES.configurator as RoleName])]) {
      expect(decidePut(collections, 'blog:public', file('image/png'), u).status).toBe('refused')
    }
  })

  test('HTML is not a blog file type', () => {
    expect(decidePut(collections, 'blog:public', file('text/html'), who([ROLES.author as RoleName]))).toMatchObject({ status: 'refused', reason: 'type' })
  })
})
