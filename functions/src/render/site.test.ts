import { describe, test, expect } from 'bun:test'
import {
  affected,
  blogIndexFragment,
  composePrefetched,
  hydratedPaths,
  navFragment,
  pagePathFor,
  postIndexEntry,
  routeArtifact,
  routeKey,
  routeKeysFor,
  routeTableFragment,
  sitemapXml,
  type SiteSettings,
} from './site'

// Production's real shape (2026-10-01).
const appConfig = { title: 'inconsequence', subtitle: 'musings', defaultPath: 'blog' }
const BLOG_PATTERN = [{ regexp: '^\\/(([\\w\\d]+\\/)*)([\\w-]+)\\/?$', path: 'post/path=[3]' }]
const blogPage = { path: 'blog', title: '', description: 'the blog', tags: ['public', 'blog'], prefetch: BLOG_PATTERN, _modified: 'p1' }
const settings: SiteSettings = {
  defaultHead: { title: 'inconsequence', description: 'musings on subjects of passing interest' },
  postTitlePrefix: '',
  alwaysPrefetchBlog: true,
  defaultToBlogMetadata: true,
}
const post = (path: string, date: string, extra: Record<string, unknown> = {}) => ({
  path,
  title: `Title ${path}`,
  date,
  summary: `Summary ${path}`,
  content: `![img](https://cdn.test/${path}.webp) body`,
  keywords: ['k'],
  _modified: `m-${path}`,
  ...extra,
})

describe('routes', () => {
  test('a URL belongs to its first segment; the root to the default path', () => {
    expect(pagePathFor('/', appConfig)).toBe('blog')
    expect(pagePathFor('/blog/', appConfig)).toBe('blog')
    expect(pagePathFor('/blog/2002/8/26/it-begins', appConfig)).toBe('blog')
    expect(pagePathFor('/about?x=1', appConfig)).toBe('about')
    expect(pagePathFor('/', {})).toBe('')
  })
  test('the blog pattern names the post from the last segment', () => {
    expect(hydratedPaths('/blog/2002/8/26/it-begins', BLOG_PATTERN)).toEqual(['post/path=it-begins'])
    expect(hydratedPaths('/blog/it-begins?ref=x', BLOG_PATTERN)).toEqual(['post/path=it-begins'])
    expect(hydratedPaths('/', BLOG_PATTERN)).toEqual([])
  })
  test('serving tries the post, then the page — an unknown slug falls back to the blog index', () => {
    const table = routeTableFragment([blogPage, { path: 'about', tags: ['visible'] }])
    expect(table).toEqual({ blog: BLOG_PATTERN })
    expect(routeKeysFor('/blog/2002/8/26/it-begins', appConfig, table)).toEqual([
      'page:blog|post/path=it-begins',
      'page:blog',
    ])
    expect(routeKeysFor('/', appConfig, table)).toEqual(['page:blog'])
    expect(routeKeysFor('/about', appConfig, table)).toEqual(['page:about'])
  })
})

describe('fragments', () => {
  test('nav: visible pages in navSort, else title, order', () => {
    const nav = navFragment(appConfig, [
      { path: 'z', title: 'Zed' },
      { path: 'a', title: 'apple' },
      { path: 'n', title: 'Q', navSort: '0' },
    ])
    expect(nav.visiblePages.map((p) => p.path)).toEqual(['n', 'a', 'z'])
  })
  test('blog index: only published posts; 6 in full, 30 summarised', () => {
    const posts = Array.from({ length: 40 }, (_, i) => post(`p${i}`, `2026-01-${String(40 - i).padStart(2, '0')}`))
    posts.splice(2, 0, post('draft', ''))
    const b = blogIndexFragment(posts, 'T')
    expect(b.latestPosts).toHaveLength(6)
    expect(b.latestPosts.map((p) => p.path)).not.toContain('draft')
    expect(b.recentPosts).toHaveLength(30)
    expect(Object.keys(b.recentPosts[0]).sort()).toEqual(['date', 'keywords', 'path', 'summary', 'title'])
  })
})

describe('route artifacts — the head and data the old handlers produced', () => {
  const latest = post('newest', '2026-08-28')

  test('a post URL: the post\'s head (prefix, summary, Markdown image, article) and the post as data', () => {
    const p = post('it-begins', '2002-08-26')
    const a = routeArtifact({
      url: '/blog/2002/8/26/it-begins',
      pagePath: 'blog',
      page: blogPage,
      hydrated: { 'post/path=it-begins': p },
      latestPost: latest,
      settings: { ...settings, postTitlePrefix: 'blog: ' },
    })
    expect(a.key).toBe('page:blog|post/path=it-begins')
    expect(a.head).toEqual({
      title: 'blog: Title it-begins',
      description: 'Summary it-begins',
      imageUrl: 'https://cdn.test/it-begins.webp',
      url: '/blog/it-begins',
      type: 'article',
    })
    expect(a.data['post/path=it-begins']).toBe(p)
    expect(a.sources).toEqual({ 'page/path=blog': 'p1', 'post/path=it-begins': 'm-it-begins' })
  })

  test('the blog index: the latest post\'s head (defaultToBlogMetadata)', () => {
    const a = routeArtifact({ url: '/', pagePath: 'blog', page: blogPage, hydrated: {}, latestPost: latest, settings })
    expect(a.key).toBe('page:blog')
    expect(a.head.title).toBe('Title newest')
    expect(a.head.url).toBe('/blog/newest')
  })

  test('…and without that setting, the page\'s own head', () => {
    const a = routeArtifact({
      url: '/blog/',
      pagePath: 'blog',
      page: blogPage,
      hydrated: {},
      latestPost: latest,
      settings: { ...settings, defaultToBlogMetadata: false },
    })
    expect(a.head).toMatchObject({ title: 'inconsequence', description: 'the blog', url: '/blog/', type: '' })
  })

  test('an ordinary page: its own fields over the defaults', () => {
    const a = routeArtifact({
      url: '/about',
      pagePath: 'about',
      page: { path: 'about', title: 'About', description: 'who', imageUrl: '/me.png', type: 'profile' },
      hydrated: {},
      latestPost: latest,
      settings,
    })
    expect(a.head).toEqual({ title: 'About', description: 'who', imageUrl: '/me.png', url: '/about', type: 'profile' })
  })

  test('composed: exactly the window.prefetched keys the client reads', () => {
    const posts = [latest, post('older', '2026-08-01')]
    const blog = blogIndexFragment(posts, 'T')
    const nav = navFragment(appConfig, [])
    const p = post('it-begins', '2002-08-26')
    const route = routeArtifact({
      url: '/blog/it-begins',
      pagePath: 'blog',
      page: blogPage,
      hydrated: { 'post/path=it-begins': p },
      latestPost: latest,
      settings,
    })
    const out = composePrefetched(route, nav, blog, settings)
    expect(Object.keys(out).sort()).toEqual(
      [
        'appConfig',
        'blogDataTimestamp',
        'blogVersion',
        'latestPosts',
        'page',
        'post/path=it-begins',
        'post/path=newest',
        'post/path=older',
        'recentPosts',
        'visiblePages',
      ].sort()
    )
    expect(out.latestPosts).toEqual(['newest', 'older'])
    expect(out.blogVersion).toBe(4)
  })
})

describe('sitemap', () => {
  test('published posts, valid dates, oldest first, 1-based months, with lastmod; drafts never', () => {
    const xml = sitemapXml(
      'loewald.com',
      [
        postIndexEntry(post('b', '2026-08-28T10:00:00Z')),
        postIndexEntry(post('a', '2002-08-26T12:00:00Z')),
        postIndexEntry(post('draft', '')),
        postIndexEntry(post('bad', 'not a date')),
      ],
      'T'
    )
    expect(xml).toContain('<url><loc>https://loewald.com/</loc></url><url><loc>https://loewald.com/blog/</loc></url>')
    expect(xml.indexOf('/2002/8/26/a')).toBeLessThan(xml.indexOf('/2026/8/28/b'))
    expect(xml).toContain('<lastmod>m-a</lastmod>')
    expect(xml).not.toContain('draft')
    expect(xml).not.toContain('NaN')
  })
  test('a path with XML specials is escaped', () => {
    expect(sitemapXml('h', [{ path: 'a&b', date: '2026-01-01', published: true }], 'T')).toContain('a&amp;b')
  })
})

describe('affected — what a write re-renders', () => {
  const pages = ['blog']
  const kinds = (refs: ReturnType<typeof affected>) => refs.map((r) => ('key' in r ? `${r.kind}:${r.key}` : r.kind)).sort()

  test('editing a published post\'s body: its page, the index, the blog page, the feed — not the sitemap', () => {
    const before = post('x', '2026-01-01')
    expect(kinds(affected('post', 'id', before, { ...before, content: 'new' }, pages))).toEqual(
      ['blog-index', 'feed', 'route:page:blog', 'route:page:blog|post/path=x'].sort()
    )
  })
  test('publishing adds the sitemap; unpublishing removes the stored page', () => {
    const draft = post('x', '')
    const pub = post('x', '2026-01-01')
    expect(kinds(affected('post', 'id', draft, pub, pages))).toContain('sitemap')
    const un = kinds(affected('post', 'id', pub, draft, pages))
    expect(un).toContain('route-delete:page:blog|post/path=x')
    expect(un).toContain('sitemap')
    expect(un).not.toContain('route:page:blog|post/path=x')
  })
  test('a draft edit re-renders nothing public', () => {
    const d = post('x', '')
    expect(affected('post', 'id', d, { ...d, content: 'y' }, pages)).toEqual([])
  })
  test('renaming a published post moves its page and updates the sitemap', () => {
    const a = post('old', '2026-01-01')
    const r = kinds(affected('post', 'id', a, { ...a, path: 'new' }, pages))
    expect(r).toContain('route:page:blog|post/path=new')
    expect(r).toContain('route-delete:page:blog|post/path=old')
    expect(r).toContain('sitemap')
  })
  test('pages: the nav only when visibility, title, order or path change; the route table on pattern change', () => {
    const p = { path: 'about', title: 'About', tags: ['visible'] }
    expect(kinds(affected('page', 'id', p, { ...p, source: 'x' }, pages))).toEqual(['route:page:about'])
    expect(kinds(affected('page', 'id', p, { ...p, title: 'Who' }, pages))).toContain('nav')
    expect(kinds(affected('page', 'id', p, { ...p, tags: [] }, pages))).toContain('nav')
    expect(kinds(affected('page', 'id', blogPage, { ...blogPage, prefetch: [] }, pages))).toContain('route-table')
  })
  test('config/app → the nav; other config → nothing', () => {
    expect(kinds(affected('config', 'app', {}, { title: 'x' }, pages))).toEqual(['nav'])
    expect(affected('config', 'blog-cache', {}, {}, pages)).toEqual([])
  })
  test('routeKey is stable', () => {
    expect(routeKey('blog', ['post/path=x'])).toBe('page:blog|post/path=x')
  })
})
