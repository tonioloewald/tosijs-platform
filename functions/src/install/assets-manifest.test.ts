/**
 * The assets extension's manifest (`extensions/assets/manifest.json`, D28),
 * published as `service-compris/assets/manifest.json`: a manifest the
 * installer accepts, declaring only its own namespace (D15), with the same
 * rules the blog's areas have.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { unenforcedKeywords } from 'tosijs-schema'
import { validateManifest, type Manifest } from './manifest'
import { compileManifest } from './compile'
import {
  ROLES,
  anonymousUser,
  type RoleName,
  type UserRoles,
} from '../collections/roles'
import { decidePut, isPublicArea } from '../collections/blob'
import type { CollectionMap } from '../collections/access'

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf-8')) as Manifest
const manifest = read('../../../extensions/assets/manifest.json')
const blog = read('../../../manifests/blog.json')
const opts = {
  unenforced: (s: Record<string, unknown>) =>
    unenforcedKeywords(s as never) as string[],
  knownRoles: Object.values(ROLES),
}
const who = (roles: RoleName[]): UserRoles =>
  ({ ...anonymousUser, roles, principal: { uid: 'u1' } } as UserRoles)
const file = (contentType: string) => ({
  path: 'a/b.png',
  contentType,
  bytes: 10,
  sha256: 'a'.repeat(64),
})
const CONTENT_ROLES = [
  ROLES.author,
  ROLES.editor,
  ROLES.admin,
  ROLES.developer,
  ROLES.owner,
] as RoleName[]

describe('extensions/assets/manifest.json', () => {
  test('is a manifest the installer accepts', () => {
    expect(validateManifest(manifest, opts)).toEqual([])
  })

  test('declares only assets: areas', () => {
    expect(manifest.name).toBe('assets')
    expect(Object.keys(manifest.collections).sort()).toEqual([
      'assets:private',
      'assets:public',
    ])
  })

  const collections = compileManifest(manifest) as CollectionMap

  test('assets:public is public, assets:private is not', async () => {
    expect(await isPublicArea(collections, 'assets:public')).toBe(true)
    expect(await isPublicArea(collections, 'assets:private')).toBe(false)
  })

  test('every content role may write both areas, and nobody else may', () => {
    for (const role of CONTENT_ROLES) {
      for (const area of ['assets:public', 'assets:private']) {
        expect(
          decidePut(collections, area, file('image/png'), who([role])).status
        ).toBe('allowed')
      }
    }
    for (const u of [anonymousUser, who([ROLES.configurator as RoleName])]) {
      expect(
        decidePut(collections, 'assets:public', file('image/png'), u).status
      ).toBe('refused')
    }
  })

  test('its areas have the same limits and rules as the blog’s', () => {
    // The blog's storage areas only: its posts and pages are not files.
    const areas = (m: Manifest, ns: string) =>
      Object.fromEntries(
        Object.entries(m.collections)
          .filter(([, c]) => c.blob)
          .map(([name, c]) => [name.replace(`${ns}:`, ''), c])
      )
    expect(Object.keys(areas(blog, 'blog'))).toEqual(['public', 'private'])
    expect(areas(manifest, 'assets')).toEqual(areas(blog, 'blog'))
  })
})
