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
import { collectionsFor } from '../install/installed'
import { ComputedStore, Deps, depsOfWrite, type ComputedBackend, type Entry } from './computed'
import { INVALIDATING_COLLECTIONS, isInvalidatedDep } from './rules'
export { INVALIDATING_COLLECTIONS }
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
  withTitlePrefix,
} from './site'

/**
 * Bump when a renderer or the page template changes: everything recomputes
 * lazily. Each version has its OWN collection, so an old one is never scanned
 * by invalidation and can be dropped whole.
 */
export const RENDER_VERSION = 'r3'
const RENDER_COLLECTION = `system:render-${RENDER_VERSION}`
/** Shared by all versions: which deps were invalidated, and when (see computed.ts, Races). */
const LOG_COLLECTION = 'system:render-log'
/**
 * Backstop for changes no hook observes (console edits, seeds, restores,
 * access-rule changes). A day, not an hour: the CDN already serves hot pages,
 * and an hour would make loewald's long tail miss on nearly every read
 * (re-review). After an out-of-band edit, purge with scripts/render-store.js.
 */
const BACKSTOP_MAX_AGE_SECONDS = 24 * 3600

// ── the Firestore backend ────────────────────────────────────────────────

const docRef = (key: string) =>
  admin.firestore().collection(RENDER_COLLECTION).doc(encodeURIComponent(key))
const logRef = (dep: string) =>
  admin.firestore().collection(LOG_COLLECTION).doc(encodeURIComponent(dep).slice(0, 1400))

/** A lost race, as Firestore reports it: anything else is a real failure. */
const isLostRace = (e: unknown) => {
  const code = (e as { code?: number | string })?.code
  // 6 ALREADY_EXISTS, 9 FAILED_PRECONDITION; 5 NOT_FOUND (purged mid-fill) and
  // 10 ABORTED mean the same thing here: someone else changed the key.
  return [5, 6, 9, 10, 'not-found', 'already-exists', 'failed-precondition', 'aborted'].includes(code as never)
}
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
    // Every field written, so a recompute never inherits an old `check`.
    const full = { key, value: entry.value, deps: entry.deps ?? [], computedAt: entry.computedAt, check: entry.check ?? null }
    try {
      if (expected === null) {
        await ref.create(full) // fails if someone created it meanwhile
      } else {
        const [s, n] = expected.split('.').map(Number)
        await ref.update(
          { ...full, stale: admin.firestore.FieldValue.delete() },
          { lastUpdateTime: new admin.firestore.Timestamp(s, n) }
        )
      }
      return true
    } catch (e) {
      if (isLostRace(e)) return false // invalidated or filled since we read it
      throw e // too large, quota, permission…: a real failure, reported by the store
    }
  },
  async writeAll(entries) {
    // Merge: a stale marker keeps the recorded deps, so cascades still find it.
    const writer = admin.firestore().bulkWriter()
    let failed = 0
    writer.onWriteError((err) => {
      if (err.failedAttempts < 3) return true // retry
      failed++
      return false
    })
    for (const [key, entry] of entries) writer.set(docRef(key), { ...entry, key }, { merge: true }).catch(() => undefined)
    await writer.close()
    if (failed) throw new Error(`${failed} stale marker(s) could not be written`)
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
  async logInvalidation(deps) {
    // Chunked, never truncated: an unlogged dep would reopen the first-fill race.
    for (let i = 0; i < deps.length; i += 450) {
      const batch = admin.firestore().batch()
      for (const dep of deps.slice(i, i + 450)) batch.set(logRef(dep), { dep, at: admin.firestore.FieldValue.serverTimestamp() })
      await batch.commit()
    }
  },
  async invalidatedSince(deps, sinceMs) {
    if (!deps.length) return false
    const snaps = await admin.firestore().getAll(...deps.map(logRef))
    return snaps.some((s) => {
      const at = s.exists ? (s.data()?.at as admin.firestore.Timestamp | undefined) : undefined
      return Boolean(at && at.toMillis() >= sinceMs)
    })
  },
}

export const renderStore = new ComputedStore(firestoreBackend, RENDER_VERSION, {
  defaultPolicy: { maxAgeSeconds: BACKSTOP_MAX_AGE_SECONDS },
  isInvalidatedDep,
  onError: (what, e) => functions.logger.error(`render store: ${what} failed`, e),
})

// ── public reads that record what they read ──────────────────────────────

/** A GET with no credentials: getDoc/getDocs then see exactly what an anonymous visitor sees. */
const PUBLIC_REQUEST = { method: 'GET', headers: {} } as unknown as AuthenticatedRequest
const NO_RESPONSE = {} as Response

async function readPublic(path: string, deps: Deps): Promise<Record<string, any> | undefined> {
  deps.add(`doc:${path}`)
  // A lookup by field (`post/path=x`) is invalidated by value only for UNIQUE
  // fields (depsOfWrite); a lookup by any other field (a tag) never would be.
  const lookup = path.match(/^([^/]+)\/([^=/]+)=/)
  if (lookup) {
    const live = (await collectionsFor(lookup[1]))[lookup[1]]
    if (!((live?.unique as string[] | undefined) ?? []).includes(lookup[2])) {
      deps.cannotStore(`${path}: lookup by a non-unique field`)
    }
  }
  // noCache: the per-instance doc cache is not invalidated by writes.
  const r = await getDoc(PUBLIC_REQUEST, NO_RESPONSE, path, { noCache: true })
  return r.ok ? (r.data as Record<string, any>) : undefined
}

async function listPublic(path: string, deps: Deps, limit: number, order = '') {
  deps.add(`list:${path.split('/')[0]}`)
  return getDocs(PUBLIC_REQUEST, NO_RESPONSE, path, limit, false, order)
}

// ── what is computed ─────────────────────────────────────────────────────

/**
 * The settings a route COMPUTE uses: static only (config.ts). The post-title
 * prefix from config/blog is applied when serving (withTitlePrefix), so routes
 * do not depend on config/blog and editing it does not invalidate them all.
 */
const ROUTE_SETTINGS: SiteSettings = {
  defaultHead: siteConfig.defaultHead,
  postTitlePrefix: '',
  alwaysPrefetchBlog: siteConfig.alwaysPrefetchBlog,
  defaultToBlogMetadata: siteConfig.defaultToBlogMetadata,
}

/** config/blog's prefix, as its own small computed value (one read on a hit). */
const titlePrefix = () =>
  renderStore.get<string>('title-prefix', async (deps) => {
    const blog = await readPublic('config/blog', deps)
    return { value: (blog?.prefix as string | undefined) ?? '', storable: true }
  })

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
 * Every page the PUBLIC can read. The public may LIST only `visible` pages, so
 * the page paths come from a privileged list (paths only), and each page is
 * then read AS THE PUBLIC: a page it cannot read is not in the table, so it is
 * not routed, rendered or revealed (adversarial review: no privileged reads
 * in what is stored).
 */
const routeTable = (parent?: Deps) =>
  renderStore.get<RouteTable>(
    'route-table',
    async (deps) => {
      deps.add('list:page')
      const paths = (await admin.firestore().collection('page').select('path').get()).docs
        .map((d) => d.data().path as string | undefined)
        .filter((p): p is string => typeof p === 'string')
      const pages = (await Promise.all(paths.map((p) => readPublic(`page/path=${p}`, deps)))).filter(
        (p): p is Record<string, any> => Boolean(p)
      )
      return { value: routeTableFragment(pages), storable: true }
    },
    { parent }
  )

/** Parse a route key back into its page and hydrated document paths. */
export function parseRouteKey(key: string): { pagePath: string; hydrated: string[] } {
  const [page, ...hydrated] = key.split('|')
  return { pagePath: page.replace(/^page:/, ''), hydrated }
}

/**
 * One route, rendered as the public, from its KEY alone (no request input).
 * `null` means the key does not apply: its named document does not exist, or
 * the public may not read it. Neither that nor a draft is stored, so a caller
 * cannot fill the store with keys of its choosing.
 */
const route = (key: string) =>
  renderStore.get<RouteArtifact | null>(key, async (deps) => {
    const settings = ROUTE_SETTINGS
    const { pagePath, hydrated: paths } = parseRouteKey(key)
    const page = await readPublic(`page/path=${pagePath}`, deps)
    const hydrated: Record<string, Record<string, any> | undefined> = {}
    for (const p of paths) hydrated[p] = await readPublic(p, deps)
    if (!page || paths.some((p) => hydrated[p] === undefined)) return { value: null, storable: false }
    const isDraft = Object.entries(hydrated).some(([p, d]) => p.startsWith('post/') && d && !isPublished(d))
    // (Whether the rest may be kept — only reads that writes invalidate — is
    // enforced by the store itself: isInvalidatedDep.)
    // Only the blog page's head reads the blog index (the latest post's
    // details), so only it depends on it: a post edit must not invalidate
    // every route on the site (adversarial review).
    const needsLatest = page.path === 'blog' && paths.length === 0 && settings.defaultToBlogMetadata
    const latestPost = needsLatest ? (await blogIndex(deps)).latestPosts[0] : undefined
    const artifact = routeArtifact({ pagePath, page, hydrated, latestPost, settings })
    return { value: artifact, storable: !isDraft }
  })

/** sitemap.xml from the PUBLIC list of posts; the host is read inside the compute (it is a dep). */
const sitemap = () =>
  renderStore.get<string>('sitemap', async (deps) => {
    const appConfig = (await readPublic('config/app', deps)) as AppConfig | undefined
    // Newest first: if a scan cap ever truncates, it drops the OLDEST posts
    // (sitemapXml sorts by date itself).
    const posts = await listPublic('post', deps, 5000, 'date(desc)')
    return {
      value: sitemapXml(siteHost(appConfig), posts.map((p) => postIndexEntry(p)), new Date().toISOString()),
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
  const [n, table, blog, prefix] = await Promise.all([nav(), routeTable(), blogIndex(), titlePrefix()])
  const settings = ROUTE_SETTINGS
  // Most specific first: a post, then its page (the blog index) when the post
  // does not exist, as the old handler did. An unknown page has no keys at all.
  for (const key of routeKeysFor(url, n.appConfig, table)) {
    const artifact = await route(key)
    if (artifact) {
      return {
        status: 200,
        head: withTitlePrefix(artifact, prefix),
        prefetched: composePrefetched(artifact, n, blog, settings),
      }
    }
  }
  // Not a page: the site's 404 page if it has one, with status 404.
  const notFound = Object.prototype.hasOwnProperty.call(table, '404') ? await route('page:404') : null
  const shown =
    notFound ??
    routeArtifact({ pagePath: pagePathFor(url, n.appConfig), page: undefined, hydrated: {}, latestPost: undefined, settings })
  return { status: 404, head: withTitlePrefix(shown, prefix), prefetched: composePrefetched(shown, n, blog, settings) }
}

/** The site's host for absolute URLs at render time: config/app `host`, else SITE_HOST. */
export function siteHost(appConfig: AppConfig | undefined): string {
  return ((appConfig as { host?: string } | undefined)?.host || process.env.SITE_HOST || '').replace(/\/+$/, '')
}

export async function serveSitemap(): Promise<string> {
  return sitemap()
}

// ── invalidation ─────────────────────────────────────────────────────────

/**
 * After a committed write: invalidate everything computed from what it changed
 * (the document, its unique-field lookups before and after, its collection's
 * lists), cascading to everything computed from those. No rendering here.
 */
export const invalidateAfterWrite = (collection: string) =>
  async (_data: unknown, _roles: unknown, change?: WriteChange): Promise<void> => {
    if (!change) return
    try {
      // The LIVE config (the registry's, if that is where it comes from), not
      // the compiled one frozen at import: unique fields can change.
      const live = (await collectionsFor(collection))[collection]
      const lookupFields = (live?.unique as string[] | undefined) ?? []
      const id = change.path.split('/').pop() ?? ''
      await renderStore.invalidateDependents(depsOfWrite(collection, id, change.before, change.after, lookupFields))
    } catch (e) {
      // Loud: a missed invalidation leaves a value stale until the backstop max age.
      functions.logger.error(`render: invalidation after a ${collection} write failed; values may be stale for up to ${BACKSTOP_MAX_AGE_SECONDS}s`, e)
    }
  }
