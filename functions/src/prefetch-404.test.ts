/**
 * Bad URLs on both render paths (#3891, #3913): a 404 status, the home page,
 * and `notFound` (the path asked for) so the client can say so. The
 * per-request path is what a new site runs; render-on-store is opt-in.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { serveLocal, type LocalHost } from './adapters/bun/serve'
import { dataStore } from './datastore'

const FIREBASE_JSON = join(__dirname, '../../firebase.json')
const created = new Date().toJSON()

let dir = ''
let host: LocalHost

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'prefetch-404-'))
  host = await serveLocal({ dataDir: dir, port: 0, firebaseJson: FIREBASE_JSON })
  await dataStore.set('config/app', { title: 'Test', description: '', defaultPath: 'blog' })
  await dataStore.set('page/blog', {
    path: 'blog',
    title: 'Blog',
    tags: ['public', 'visible'],
    source: '',
    prefetch: [{ regexp: '^\\/(([\\w\\d]+\\/)*)([\\w-]+)\\/?$', path: 'post/path=[3]' }],
    _created: created,
  })
  await dataStore.set('page/about', { path: 'about', title: 'About', tags: ['public', 'visible'], source: '', _created: created })
  await dataStore.set('post/p1', {
    path: 'it-begins',
    title: 'It begins',
    date: '2002-08-26T00:00:00.000Z',
    content: 'hello',
    _created: created,
  })
})

afterAll(async () => {
  await host?.close()
  rmSync(dir, { recursive: true, force: true })
})

const get = async (path: string) => {
  const res = await fetch(`${host.url}${path}`)
  const html = await res.text()
  const notFound = html.match(/"notFound":"([^"]*)"/)?.[1]
  const page = html.match(/"page":\{"path":"([^"]*)"/)?.[1] ?? html.match(/"path":"(blog|about)"/)?.[1]
  return { status: res.status, notFound, page }
}

for (const engine of ['per-request', 'store'] as const) {
  describe(`${engine} rendering`, () => {
    beforeAll(() => {
      if (engine === 'store') process.env.RENDER_ON_STORE = 'true'
      else delete process.env.RENDER_ON_STORE
    })
    afterAll(() => {
      delete process.env.RENDER_ON_STORE
    })

    test('real URLs are 200, not marked', async () => {
      for (const path of ['/', '/blog/', '/about', '/blog/2002/8/26/it-begins']) {
        const got = await get(path)
        expect({ path, status: got.status, notFound: got.notFound }).toEqual({ path, status: 200, notFound: undefined })
      }
    })

    test('an unknown page is a 404 showing the home page', async () => {
      expect(await get('/no-such-page?x=1')).toEqual({ status: 404, notFound: '/no-such-page', page: 'blog' })
    })

    test('a missing post is a 404 showing the blog, not a 200', async () => {
      expect(await get('/blog/no-such-post')).toEqual({ status: 404, notFound: '/blog/no-such-post', page: 'blog' })
    })
  })
}

describe('render on store: the page is readable without JavaScript (#4063)', () => {
  beforeAll(() => {
    process.env.RENDER_ON_STORE = 'true'
  })
  afterAll(() => {
    delete process.env.RENDER_ON_STORE
  })
  const bodyOf = async (path: string) => (await (await fetch(`${host.url}${path}`)).text()).split('<body>')[1] ?? ''

  test('a post URL: the post in the body, marked for the client to replace', async () => {
    const body = await bodyOf('/blog/2002/8/26/it-begins')
    expect(body).toContain('<article data-ssr><h1>It begins</h1><p>hello</p>')
  })

  test('a page with no post of its own has no body yet', async () => {
    expect(await bodyOf('/about')).toBe('</body></html>')
  })
})
