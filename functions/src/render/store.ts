/**
 * Render on store (D23) as a COMPUTED STORE (owner, 2026-10-03): every page,
 * fragment and the sitemap is a derived value that is invalidated by writes to
 * what it READ, and computed on the next read. No eager rendering on the write
 * path, no render-all, no hand-written "what does this write affect" table:
 * each renderer records its own dependencies while it reads (computed.ts).
 *
 * Rendering is always public (D10): documents are read through the same
 * getDoc/getDocs a visitor's request uses, with a request that carries no
 * credentials, so access filters apply exactly as they do to an anonymous
 * visitor. Nothing a privileged writer can see is baked into a stored value.
 *
 * Where values live: `system:render/<encoded namespace:key>`. `system:` is
 * reserved and unregistered, so nothing reaches it through /doc. RENDER_VERSION
 * is the namespace: bump it when a renderer or the page template changes, and
 * every value misses and recomputes on its next read.
 */
import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import type { Response } from 'express'
import { getDoc } from '../doc'
import { getDocs } from '../docs'
import type { AuthenticatedRequest } from '../utilities'
import type { WriteChange } from '../collections/access'
import { config as siteConfig } from '../config'
import { isPublished } from '../../shared/post'
import { ComputedStore, Deps, depsOfWrite, type ComputedBackend, type Entry } from './computed'
import {
  blogIndexFragment,
  composePrefetched,
  navFragment,
  pagePathFor,
  postIndexEntry,
  routeArtifact,
  routeKeysFor,
  routeTableFragment,
  sitemapXml,
  type AppConfig,
  type BlogIndexFragment,
  type NavFragment,
  type RouteArtifact,
  type RouteTable,
  type SiteSettings,
} from './site'

/** Bump when a renderer or the page template changes: everything recomputes lazily. */
export const RENDER_VERSION = 'r1'
const RENDER_COLLECTION = 'system:render'

// ── the Firestore backend ────────────────────────────────────────────────

const docRef = (fullKey: string) =>
  admin.firestore().collection(RENDER_COLLECTION).doc(encodeURIComponent(fullKey))

const versionOf = (snap: FirebaseFirestore.DocumentSnapshot): string | null =>
  snap.exists && snap.updateTime ? `${snap.updateTime.seconds}.${snap.updateTime.nanoseconds}` : null

export const firestoreBackend: ComputedBackend = {
  async read(key) {
    const snap = await docRef(key).get()
    return { entry: snap.exists ? (snap.data() as Entry) : undefined, version: versionOf(snap) }
  },
  async readMany(keys) {
    if (!keys.length) return []
    const snaps = await admin.firestore().getAll(...keys.map(docRef))
    return snaps.map((s) => ({ entry: s.exists ? (s.data() as Entry) : undefined, version: versionOf(s) }))
  },
  async writeIfUnchanged(key, entry, expected) {
    const ref = docRef(key)
    try {
      if (expected === null) {
        await ref.create({ ...entry, key }) // fails if someone created it meanwhile
      } else {
        const [s, n] = expected.split('.').map(Number)
        await ref.update(
          { ...entry, key, stale: admin.firestore.FieldValue.delete() },
          { lastUpdateTime: new admin.firestore.Timestamp(s, n) }
        )
      }
      return true
    } catch {
      return false // lost the race: invalidated or filled since we read it
    }
  },
  async writeAll(entries) {
    // Merge: a stale marker keeps the recorded deps, so cascades still find it.
    const writer = admin.firestore().bulkWriter()
    for (const [key, entry] of entries) writer.set(docRef(key), { ...entry, key }, { merge: true })
    await writer.close()
  },
  async dependents(deps) {
    const out = new Set<string>()
    for (let i = 0; i < deps.length; i += 30) {
      const snap = await admin
        .firestore()
        .collection(RENDER_COLLECTION)
        .where('deps', 'array-contains-any', deps.slice(i, i + 30))
        .select('key')
        .get()
      for (const d of snap.docs) out.add(d.data().key as string)
    }
    return [...out]
  },
}

export const renderStore = new ComputedStore(firestoreBackend, RENDER_VERSION)

// ── public reads that record what they read ──────────────────────────────

/** A GET with no credentials: getDoc/getDocs then see exactly what an anonymous visitor sees. */
const PUBLIC_REQUEST = { method: 'GET', headers: {} } as unknown as AuthenticatedRequest
const NO_RESPONSE = {} as Response

async function readPublic(path: string, deps: Deps): Promise<Record<string, any> | undefined> {
  deps.add(`doc:${path}`)
  const r = await getDoc(PUBLIC_REQUEST, NO_RESPONSE, path)
  return r.ok ? (r.data as Record<string, any>) : undefined
}

async function listPublic(path: string, deps: Deps, limit: number, order = '') {
  deps.add(`list:${path.split('/')[0]}`)
  return getDocs(PUBLIC_REQUEST, NO_RESPONSE, path, limit, false, order)
}

// ── what is computed ─────────────────────────────────────────────────────

async function loadSettings(deps: Deps): Promise<SiteSettings> {
  const blog = await readPublic('config/blog', deps)
  return {
    defaultHead: siteConfig.defaultHead,
    postTitlePrefix: (blog?.prefix as string | undefined) ?? '',
    alwaysPrefetchBlog: siteConfig.alwaysPrefetchBlog,
    defaultToBlogMetadata: siteConfig.defaultToBlogMetadata,
  }
}

const nav = (parent?: Deps) =>
  renderStore.get<NavFragment>(
    'nav',
    async (deps) => {
      const appConfig = (await readPublic('config/app', deps)) as AppConfig | undefined
      const pages = await listPublic('page/tags=visible', deps, 100)
      return { value: navFragment(appConfig, pages), storable: true }
    },
    { parent }
  )

const blogIndex = (parent?: Deps) =>
  renderStore.get<BlogIndexFragment>(
    'blog-index',
    async (deps) => {
      const posts = await listPublic('post', deps, 30, 'date(desc)')
      return { value: blogIndexFragment(posts, new Date().toISOString()), storable: true }
    },
    { parent }
  )

/**
 * Page patterns are not sensitive, and a page the public cannot LIST (only
 * `visible` pages are listable) may still be readable, so this one read is
 * privileged and keeps nothing but paths and patterns.
 */
const routeTable = (parent?: Deps) =>
  renderStore.get<RouteTable>(
    'route-table',
    async (deps) => {
      deps.add('list:page')
      const snap = await admin.firestore().collection('page').get()
      return { value: routeTableFragment(snap.docs.map((d) => d.data())), storable: true }
    },
    { parent }
  )

/** Parse a route key back into its page and hydrated document paths. */
export function parseRouteKey(key: string): { pagePath: string; hydrated: string[] } {
  const [page, ...hydrated] = key.split('|')
  return { pagePath: page.replace(/^page:/, ''), hydrated }
}

/**
 * One route, rendered as the public. `null` means the key does not apply (its
 * named post does not exist, or the public may not read it): that is STORED
 * too, with its deps, so a miss costs nothing until the post appears. A draft
 * (readable by link, unpublished) is never stored.
 */
const route = (key: string, url: string) =>
  renderStore.get<RouteArtifact | null>(key, async (deps) => {
    const settings = await loadSettings(deps)
    const blog = await blogIndex(deps)
    const { pagePath, hydrated: paths } = parseRouteKey(key)
    const page = (await readPublic(`page/path=${pagePath}`, deps)) ?? (await readPublic('page/path=404', deps))
    const hydrated: Record<string, Record<string, any> | undefined> = {}
    for (const p of paths) hydrated[p] = await readPublic(p, deps)
    if (!page || paths.some((p) => hydrated[p] === undefined)) return { value: null, storable: true }
    const isDraft = Object.entries(hydrated).some(([p, d]) => p.startsWith('post/') && d && !isPublished(d))
    const artifact = routeArtifact({ url, pagePath, page, hydrated, latestPost: blog.latestPosts[0], settings })
    return { value: artifact, storable: !isDraft }
  })

const sitemap = (host: string) =>
  renderStore.get<string>('sitemap', async (deps) => {
    deps.add('list:post')
    const snap = await admin.firestore().collection('post').select('path', 'date', '_modified').get()
    return {
      value: sitemapXml(host, snap.docs.map((d) => postIndexEntry(d.data())), new Date().toISOString()),
      storable: true,
    }
  })

// ── serving ──────────────────────────────────────────────────────────────

export interface Served {
  status: number
  head: RouteArtifact['head']
  prefetched: Record<string, unknown>
}

/** What a URL is served as. A hit is a handful of document reads and no queries. */
export async function serve(url: string): Promise<Served> {
  const [n, table, blog] = await Promise.all([nav(), routeTable(), blogIndex()])
  const settings = await loadSettings(new Deps())
  // Most specific first: a post, then its page (the blog index) when the post
  // does not exist, as the old handler did.
  for (const key of routeKeysFor(url, n.appConfig, table)) {
    const artifact = await route(key, url)
    if (artifact) {
      return { status: 200, head: artifact.head, prefetched: composePrefetched(artifact, n, blog, settings) }
    }
  }
  // Not even the page: the site's 404 (or nothing), said honestly.
  const missing = routeArtifact({
    url,
    pagePath: pagePathFor(url, n.appConfig),
    page: undefined,
    hydrated: {},
    latestPost: undefined,
    settings,
  })
  return { status: 404, head: missing.head, prefetched: composePrefetched(missing, n, blog, settings) }
}

/** The site's host for absolute URLs at render time: config/app `host`, else SITE_HOST. */
export function siteHost(appConfig: AppConfig | undefined): string {
  return ((appConfig as { host?: string } | undefined)?.host || process.env.SITE_HOST || '').replace(/\/+$/, '')
}

export async function serveSitemap(): Promise<string> {
  return sitemap(siteHost((await nav()).appConfig))
}

// ── invalidation ─────────────────────────────────────────────────────────

/**
 * After a committed write: invalidate everything computed from what it changed
 * (the document, its unique-field lookups before and after, its collection's
 * lists), cascading to everything computed from those. No rendering here.
 */
export const invalidateAfterWrite = (collection: string, lookupFields: string[]) =>
  async (_data: unknown, _roles: unknown, change?: WriteChange): Promise<void> => {
    if (!change) return
    try {
      const id = change.path.split('/').pop() ?? ''
      await renderStore.invalidateDependents(depsOfWrite(collection, id, change.before, change.after, lookupFields))
    } catch (e) {
      functions.logger.warn(`render: invalidation after a ${collection} write failed; values may be stale`, e)
    }
  }
