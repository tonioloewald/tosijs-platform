/**
 * Render on store (D23): the PURE half. Documents in, artifacts out.
 *
 * What gets stored, and what the client receives:
 *
 * - a **route artifact** per page, or per page × hydrated document (a post is
 *   the blog page × `post/path=<slug>`): its head options and its OWN data;
 * - the **nav fragment** (`appConfig` + visible pages), shared by every route;
 * - the **blog-index fragment** (latest + recent posts), shared by every route
 *   when `alwaysPrefetchBlog` is on.
 *
 * `composePrefetched` merges them into exactly the `window.prefetched` shape the
 * client reads today, so the client does not change. Ported from page.ts and
 * blog.ts's prefetch handlers, behaviour for behaviour; the differences are
 * deliberate and listed where they occur.
 */
import { firstImage } from '../social-meta'
import { isPublished } from '../../shared/post'
import type { HeadOptions } from './document'

type Doc = Record<string, any>

export interface AppConfig {
  title?: string
  subtitle?: string
  description?: string
  defaultPath?: string
}

export interface PrefetchPattern {
  regexp?: string
  path: string
}

export interface SiteSettings {
  /** The head when nothing more specific applies (was hardcoded in prefetch.ts). */
  defaultHead: { title: string; description: string }
  /** Prefixed to a post's title in its head (config/blog `prefix`). */
  postTitlePrefix: string
  /** Blog data on every route, not only the blog page (config.ts). */
  alwaysPrefetchBlog: boolean
  /** The blog page's head shows the latest post when no post is named (config.ts). */
  defaultToBlogMetadata: boolean
}

// ── routes ───────────────────────────────────────────────────────────────

/** The page a URL belongs to: its first segment, or the default path at the root. */
export function pagePathFor(url: string, appConfig: AppConfig | undefined): string {
  const [pathname] = url.substring(1).split(/[?#]/, 1)
  const [first] = pathname.split('/')
  return !first && appConfig?.defaultPath ? appConfig.defaultPath : first
}

/**
 * The documents a page's `prefetch` patterns name for this URL, e.g. the blog
 * page's `post/path=[3]` → `post/path=it-begins`. A pattern that does not match
 * names nothing (the old code skipped it the same way).
 */
export function hydratedPaths(url: string, patterns: PrefetchPattern[] | undefined): string[] {
  const out: string[] = []
  for (const { regexp, path } of patterns ?? []) {
    const parts = regexp ? url.split(/[?#]/, 1)[0].match(new RegExp(regexp)) ?? [] : []
    let ok = true
    const hydrated = path.replace(/\[(\d+)\]/g, (_, i) => {
      const part = parts[Number(i)]
      if (part === undefined) ok = false
      return part ?? ''
    })
    if (ok) out.push(hydrated)
  }
  return out
}

/** The stored artifact a route is served from: the page, plus any hydrated documents. */
export const routeKey = (pagePath: string, hydrated: string[]): string =>
  [`page:${pagePath}`, ...hydrated].join('|')

/**
 * The route table: each page's `prefetch` patterns, by page path. Serving needs
 * it to find a URL's artifact without a query; it changes only when a page's
 * patterns do.
 */
export type RouteTable = Record<string, PrefetchPattern[]>

export function routeTableFragment(pages: Doc[]): RouteTable {
  const table: RouteTable = {}
  for (const p of pages) if (p.path && Array.isArray(p.prefetch) && p.prefetch.length) table[p.path] = p.prefetch
  return table
}

/**
 * The artifact keys to try for a URL, most specific first: the page with its
 * hydrated documents (a post), then the page alone. An unknown post therefore
 * falls back to its page (the blog index), as the old handler did.
 */
export function routeKeysFor(url: string, appConfig: AppConfig | undefined, table: RouteTable): string[] {
  const pagePath = pagePathFor(url, appConfig)
  const hydrated = hydratedPaths(url, table[pagePath])
  const keys = hydrated.length ? [routeKey(pagePath, hydrated), routeKey(pagePath, [])] : [routeKey(pagePath, [])]
  return keys
}

// ── fragments ────────────────────────────────────────────────────────────

export interface NavFragment {
  appConfig: AppConfig | undefined
  visiblePages: Doc[]
}

/** appConfig + the visible pages, in nav order (navSort, else title). */
export function navFragment(appConfig: AppConfig | undefined, visiblePages: Doc[]): NavFragment {
  const sortKey = (p: Doc) => String(p.navSort ?? String(p.title ?? '').toLowerCase())
  return {
    appConfig,
    visiblePages: [...visiblePages].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
  }
}

export interface BlogIndexFragment {
  /** The latest posts in FULL (they are embedded, so the blog renders without a fetch). */
  latestPosts: Doc[]
  /** The recent posts' summaries, for the sidebar. */
  recentPosts: Doc[]
  blogDataTimestamp: string
}

export const LATEST_POSTS = 6
export const RECENT_POSTS = 30
const RECENT_FIELDS = ['title', 'date', 'summary', 'keywords', 'path', '_path']

/**
 * Built from the published posts, newest first. The caller passes only what
 * the PUBLIC may list (D10); this re-checks, because a draft in the index
 * would be a leak, and the check is cheap.
 */
export function blogIndexFragment(postsNewestFirst: Doc[], renderedAt: string): BlogIndexFragment {
  const published = postsNewestFirst.filter((p) => isPublished(p))
  return {
    latestPosts: published.slice(0, LATEST_POSTS),
    recentPosts: published.slice(0, RECENT_POSTS).map((p) =>
      Object.fromEntries(RECENT_FIELDS.filter((f) => p[f] !== undefined).map((f) => [f, p[f]]))
    ),
    blogDataTimestamp: renderedAt,
  }
}

// ── the route artifact ───────────────────────────────────────────────────

export interface RouteArtifact {
  key: string
  head: HeadOptions
  /** This route's OWN data: the page and any hydrated documents. */
  data: Record<string, unknown>
  /** Document path → its `_modified` when rendered, so staleness is visible. */
  sources: Record<string, string | null>
}

const sourceOf = (doc: Doc | undefined) => (doc ? (doc._modified as string | undefined) ?? null : null)

/**
 * The head and own data of one route.
 *
 * `page` is the resolved page (or the 404 page, or undefined). `hydrated` maps
 * each hydrated path to its document, or undefined when it does not exist or
 * the public may not read it. `latestPost` is needed only for the blog page's
 * "show the latest post" head.
 */
export function routeArtifact(input: {
  url: string
  pagePath: string
  page: Doc | undefined
  hydrated: Record<string, Doc | undefined>
  latestPost: Doc | undefined
  settings: SiteSettings
}): RouteArtifact {
  const { url, pagePath, page, hydrated, latestPost, settings } = input
  const head: HeadOptions = {
    title: settings.defaultHead.title,
    description: settings.defaultHead.description,
    imageUrl: '',
    url: url.split(/[?#]/, 1)[0],
    type: '',
  }
  if (page) {
    if (page.title) head.title = page.title
    if (page.description) head.description = page.description
    if (page.imageUrl) head.imageUrl = page.imageUrl
    if (page.type) head.type = page.type
  }

  // The blog page: a named post's head, or (by setting) the latest post's.
  const post = Object.entries(hydrated).find(([p, d]) => p.startsWith('post/') && d)?.[1]
  if (page?.path === 'blog' && (post || (settings.defaultToBlogMetadata && latestPost))) {
    const shown = (post ?? latestPost) as Doc
    head.title = settings.postTitlePrefix + (shown.title || '')
    head.imageUrl = shown.imageUrl || firstImage(shown.content) || head.imageUrl
    head.description = shown.summary || head.description
    head.url = `/blog/${shown.path}`
    head.type = 'article'
  }

  const data: Record<string, unknown> = {}
  if (page) data.page = page
  const sources: Record<string, string | null> = {}
  if (page) sources[`page/path=${pagePath}`] = sourceOf(page)
  for (const [path, doc] of Object.entries(hydrated)) {
    if (doc) data[path] = doc
    sources[path] = sourceOf(doc)
  }
  return { key: routeKey(pagePath, Object.keys(hydrated)), head, data, sources }
}

/**
 * Merge the stored pieces into `window.prefetched`, the shape the client reads
 * today: appConfig, visiblePages, page, latestPosts (as PATHS), recentPosts,
 * blogDataTimestamp, blogVersion, and `post/path=<slug>` for each latest post
 * and for the route's own post.
 */
export function composePrefetched(
  route: RouteArtifact,
  nav: NavFragment,
  blog: BlogIndexFragment | undefined,
  settings: SiteSettings
): Record<string, unknown> {
  // Order matches the old handlers' merge: page data first, blog data after
  // (page.ts registers its handler before blog.ts), so for a post among the
  // latest the blog index's copy wins. Both are equally fresh: any change to a
  // published post invalidates the index too.
  const out: Record<string, unknown> = {
    appConfig: nav.appConfig,
    visiblePages: nav.visiblePages,
    ...route.data,
  }
  const onBlogPage = (route.data.page as Doc | undefined)?.path === 'blog'
  if (blog && (settings.alwaysPrefetchBlog || onBlogPage)) {
    out.latestPosts = blog.latestPosts.map((p) => p.path)
    out.recentPosts = blog.recentPosts
    out.blogDataTimestamp = blog.blogDataTimestamp
    out.blogVersion = 4
    for (const post of blog.latestPosts) out[`post/path=${post.path}`] = post
  }
  return out
}

// ── sitemap ──────────────────────────────────────────────────────────────

/** One post's entry in the per-post index the sitemap and feed are built from. */
export interface PostIndexEntry {
  path: string
  date: string
  published: boolean
  modified?: string
}

export const postIndexEntry = (post: Doc): PostIndexEntry => ({
  path: String(post.path),
  date: String(post.date ?? ''),
  published: isPublished(post),
  modified: post._modified,
})

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * sitemap.xml: the site's root and blog, then every PUBLISHED post with a
 * valid date, oldest first, at the URL the site itself links to
 * (`/blog/<y>/<m>/<d>/<path>`, month 1-based). New: `<lastmod>` from
 * `_modified`.
 */
export function sitemapXml(host: string, entries: PostIndexEntry[], renderedAt: string): string {
  const url = (loc: string, lastmod?: string) =>
    `<url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${xmlEscape(lastmod)}</lastmod>` : ''}</url>`
  const posts = entries
    .filter((e) => e.published)
    .map((e) => ({ e, d: new Date(e.date) }))
    .filter(({ d }) => !isNaN(d.valueOf()))
    .sort((a, b) => a.d.valueOf() - b.d.valueOf())
    .map(({ e, d }) =>
      url(`https://${host}/blog/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}/${e.path}`, e.modified)
    )
  return (
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    `<!-- rendered ${renderedAt} -->` +
    url(`https://${host}/`) +
    url(`https://${host}/blog/`) +
    posts.join('') +
    '</urlset>'
  )
}
