/**
 * The checked-in `manifests/blog.json` must stay a manifest the installer
 * accepts, and must decide what the blog has always decided.
 *
 * Its storage areas (#1136 step 3) grant what `storage.rules` grants for
 * `blog/`: anyone reads, the content roles write. Roles do not inherit, so each
 * content role is named; this pins that.
 *
 * Its posts and pages (`blog:post`, `blog:page`) were the platform's bare
 * `post` and `page` until D28 moved them here. Their rules moved unchanged, and
 * the behaviour the old seed-parity tests pinned is pinned here instead, on the
 * rules as installed: drafts readable by link but never listed, a page listed
 * only when `public` AND `visible`, unique titles and paths, legacy paths kept
 * exactly, and a byline that names someone.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { unenforcedKeywords } from 'tosijs-schema'
import { validateManifest, type Manifest } from './manifest'
import { compileManifest } from './compile'
import { ROLES, anonymousUser, type RoleName, type UserRoles } from '../collections/roles'
import { ALL, getMethodAccess, type CollectionMap, type REST_METHOD } from '../collections/access'
import { validate as schemaValidate } from 'tosijs-schema'
import { decidePut, isPublicArea } from '../collections/blob'

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

// ── posts and pages (D28) ────────────────────────────────────────────────

const collectionsOf = compileManifest(manifest) as CollectionMap
const decide = (name: string, method: REST_METHOD, roles: RoleName[]) =>
  getMethodAccess(collectionsOf, name, method, who(roles))
/** What a decision does to a document: allowed, denied, hidden, or shown. */
const outcome = async (decision: unknown, doc: Record<string, unknown>) => {
  if (decision === undefined) return 'deny'
  if (decision === ALL) return 'all'
  const r = await (decision as (d: unknown) => unknown)(structuredClone(doc))
  return r instanceof Error ? 'hidden' : 'shown'
}
const WRITES: REST_METHOD[] = ['POST', 'PUT', 'PATCH', 'DELETE']

describe('blog:post', () => {
  const DRAFTS = [
    { title: 'empty date', content: 'x', path: 'b', date: '' },
    { title: 'whitespace date', content: 'x', path: 'c', date: '  ' },
    { title: 'no date at all', content: 'x', path: 'd' },
  ]
  const LIVE = { title: 'published', content: 'x', path: 'a', date: '2026-01-01' }

  test('a draft is readable by link but never listed', async () => {
    // Deliberate: unpublished posts are unlisted, not secret, so a link can be
    // sent to a friend for comment. `nonEmpty` covers all three of D11's
    // "empty" shapes; testing `date !== undefined` once leaked 57 drafts.
    expect(decide('blog:post', 'GET', [])).toBe(ALL)
    const list = decide('blog:post', 'LIST', [])
    for (const draft of DRAFTS) expect(await outcome(list, draft)).toBe('hidden')
    expect(await outcome(list, LIVE)).toBe('shown')
  })

  test('authors write and list everything; the public writes nothing', async () => {
    for (const method of WRITES) {
      expect(decide('blog:post', method, [ROLES.author as RoleName])).toBe(ALL)
      expect(decide('blog:post', method, [])).toBeUndefined()
    }
    expect(decide('blog:post', 'LIST', [ROLES.author as RoleName])).toBe(ALL)
  })

  test('title and path are each unique on their own (D19)', () => {
    expect([...(collectionsOf['blog:post'].unique ?? [])].sort()).toEqual(['path', 'title'])
  })

  test('the schema needs a title and content, and keywords are a list', () => {
    const ok = (doc: Record<string, unknown>) =>
      schemaValidate(doc, collectionsOf['blog:post'].schema as never, { strict: true } as never)
    expect(ok({ title: 't', content: 'c' })).toBe(true)
    expect(ok({ title: 't', content: 'c', keywords: ['a'] })).toBe(true)
    expect(ok({ title: 't' })).toBe(false)
    expect(ok({ content: 'c' })).toBe(false)
    expect(ok({ title: 't', content: 'c', keywords: 'a' })).toBe(false)
    expect(ok({ title: 1, content: 'c' })).toBe(false)
  })

  const save = async (body: Record<string, unknown>, existing: Record<string, unknown> | undefined, roles: UserRoles) => {
    const validate = collectionsOf['blog:post'].validate
    if (!validate) throw new Error('blog:post has no validate')
    return validate(body, roles, existing)
  }
  // The published name comes from the credential (roles.ts principalIdentity).
  const author = { ...who([ROLES.author as RoleName]), principal: { uid: 'u1', name: 'Tosi' } } as UserRoles

  test('saving a LEGACY path leaves it exactly as stored (B1)', async () => {
    // 96 of 791 production paths are not what slugify would produce (trailing
    // `-`, `_`, over 80 characters). An edit must not move them.
    for (const path of ['what-s-in-a-name-', 'x'.repeat(86), 'under_score', 'Mixed-Case']) {
      const out = (await save({ title: 'Some Title', content: 'c', path }, { path }, author)) as { path: string }
      expect(out.path).toBe(path)
    }
  })

  test('a NEW post with no path gets the editor\'s slug (owner-approved 2026-09-26)', async () => {
    const expected: Record<string, string> = {
      'Hello, World!': 'hello-world',
      'What’s in a name?': 'what-s-in-a-name',
      'snake_case title': 'snake-case-title',
    }
    for (const [title, path] of Object.entries(expected)) {
      expect(((await save({ title, content: 'c' }, {}, author)) as { path: string }).path).toBe(path)
    }
  })

  test('an empty author is the writer\'s published name, or the write is refused (D24)', async () => {
    expect(((await save({ title: 't', content: 'c' }, {}, author)) as { author: string }).author).toBe('Tosi')
    expect(await save({ title: 't', content: 'c' }, {}, who([ROLES.author as RoleName]))).toBeInstanceOf(Error)
  })
})

describe('blog:page', () => {
  const page = (path: string, tags: string[]) => ({ title: 't', description: 'd', path, source: 's', tags })

  test('the public reads a page tagged public, and lists it only when also visible', async () => {
    const read = decide('blog:page', 'GET', [])
    const list = decide('blog:page', 'LIST', [])
    expect(await outcome(read, page('p1', []))).toBe('hidden')
    expect(await outcome(read, page('p2', ['public']))).toBe('shown')
    expect(await outcome(read, page('p3', ['visible']))).toBe('hidden')
    // Reachable by link, deliberately absent from navigation.
    expect(await outcome(list, page('p2', ['public']))).toBe('hidden')
    expect(await outcome(list, page('p3', ['visible']))).toBe('hidden')
    expect(await outcome(list, page('p4', ['public', 'visible']))).toBe('shown')
  })

  test('admins read, write and list everything; nobody else writes', () => {
    for (const method of ['GET', 'LIST', ...WRITES] as REST_METHOD[]) {
      expect(decide('blog:page', method, [ROLES.admin as RoleName])).toBe(ALL)
    }
    for (const roles of [[], [ROLES.author], [ROLES.editor], [ROLES.owner]] as RoleName[][]) {
      for (const method of WRITES) expect(decide('blog:page', method, roles)).toBeUndefined()
    }
  })

  test('path is unique, and tags are queryable', () => {
    expect(collectionsOf['blog:page'].unique).toEqual(['path'])
    expect(collectionsOf['blog:page'].tagFields).toEqual(['tags'])
  })

  test('the schema needs a title, description, path and source', () => {
    const ok = (doc: Record<string, unknown>) =>
      schemaValidate(doc, collectionsOf['blog:page'].schema as never, { strict: true } as never)
    expect(ok({ title: 't', description: 'd', path: 'p', source: 's' })).toBe(true)
    expect(ok({ title: 't', description: 'd', path: 'p', source: 's', tags: ['x'] })).toBe(true)
    expect(ok({ title: 't', description: 'd', path: 'p' })).toBe(false)
    expect(ok({ title: 't', description: 'd', path: 'p', source: 's', tags: 'x' })).toBe(false)
  })
})
