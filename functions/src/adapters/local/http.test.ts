/**
 * The one-server HTTP binding (adapters/local/http.ts), with stub endpoints:
 * the routes, what handlers receive, and Hosting's rules, as Firebase applies
 * them.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createServer, type Server } from 'http'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { globToRegExp, localApp, readHosting, type HostingConfig } from './http'
import type { Handler, HttpRequest } from '../../http'

describe('Hosting globs', () => {
  const cases: Array<[string, string[], string[]]> = [
    ['**', ['/', '/a', '/a/b/c'], []],
    ['/esm/*', ['/esm/x.js'], ['/esm', '/esm/a/b']],
    ['/stored/**', ['/stored', '/stored/a', '/stored/a/b'], ['/storedx', '/blob/a']],
    ['/@(blob|stored)/**', ['/blob/a', '/stored/a/b'], ['/blobs/a', '/other/a']],
    ['/@(authorize|claim|install)', ['/claim', '/install'], ['/claim/x', '/claims']],
    ['/sitemap.xml', ['/sitemap.xml'], ['/sitemapxxml']],
    ['/a/**/b', ['/a/b', '/a/x/b', '/a/x/y/b'], ['/a/xb']],
  ]
  for (const [glob, yes, no] of cases) {
    test(glob, () => {
      const re = globToRegExp(glob)
      for (const p of yes) expect(`${p}: ${re.test(p)}`).toBe(`${p}: true`)
      for (const p of no) expect(`${p}: ${re.test(p)}`).toBe(`${p}: false`)
    })
  }

  test("this repo's firebase.json: every rewrite names a known endpoint shape", () => {
    const { config } = readHosting(join(__dirname, '../../../../firebase.json'))
    expect(config.rewrites?.length).toBeGreaterThan(0)
    for (const r of config.rewrites ?? []) expect(() => globToRegExp(r.source ?? '')).not.toThrow()
  })
})

describe('serving', () => {
  let dir = ''
  let server: Server
  let base = ''
  const seen: Array<Record<string, unknown>> = []

  const echo: Handler = (req, res) => {
    const r = req as HttpRequest
    seen.push({
      url: req.url,
      path: req.path,
      body: req.body,
      raw: r.rawBody?.toString('utf8'),
      forwarded: req.headers['x-forwarded-url'],
      host: req.headers['x-forwarded-host'],
    })
    res.set('Content-Security-Policy', 'from-the-handler')
    res.set('X-Handler', 'yes')
    res.json({ ok: true })
  }
  const endpoints = {
    doc: { handler: echo },
    blob: { handler: echo },
    prefetch: { handler: echo },
    boom: {
      handler: (() => {
        throw new Error('boom')
      }) as Handler,
    },
    later: { handler: (async () => Promise.reject(new Error('later'))) as Handler },
  }
  const config: HostingConfig = {
    public: 'public',
    rewrites: [
      { source: '/blob/**', function: 'blob' },
      { source: '/boom', function: 'boom' },
      { source: '**', function: 'prefetch' },
    ],
    headers: [
      { source: '**', headers: [{ key: 'Content-Security-Policy', value: 'site-wide' }] },
      { source: '/@(blob|stored)/**', headers: [{ key: 'Content-Security-Policy', value: 'sandbox' }] },
    ],
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'local-http-'))
    const { mkdirSync } = await import('fs')
    mkdirSync(join(dir, 'public'))
    writeFileSync(join(dir, 'public', 'index.js'), 'static')
    server = createServer(localApp({ endpoints, hosting: { config, root: dir } }))
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const address = server.address()
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })
  afterAll(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const last = () => seen[seen.length - 1]

  test('a function URL: the handler sees the path after its name, with the query', async () => {
    const res = await fetch(`${base}/demo-x/us-central1/doc/a/b?p=post/x`)
    expect(res.status).toBe(200)
    expect(last()).toMatchObject({ url: '/a/b?p=post/x', path: '/a/b' })
    const bare = await fetch(`${base}/demo-x/us-central1/doc?p=1`)
    expect(bare.status).toBe(200)
    expect(last().url).toBe('/?p=1')
  })

  test('a function URL gets no Hosting headers: the handler’s stand', async () => {
    const res = await fetch(`${base}/demo-x/us-central1/blob/a:b/c`)
    expect(res.headers.get('content-security-policy')).toBe('from-the-handler')
  })

  test('a rewrite: the full path, and Hosting’s forwarded headers over the caller’s', async () => {
    const res = await fetch(`${base}/blob/a:b/c.txt?v=2`, {
      headers: { 'X-Forwarded-Url': '/forged', 'X-Forwarded-Host': 'evil.example' },
    })
    expect(res.status).toBe(200)
    expect(last()).toMatchObject({ path: '/blob/a:b/c.txt', forwarded: '/blob/a:b/c.txt?v=2' })
    expect(last().host).toBe(new URL(base).host)
  })

  test('Hosting headers replace the handler’s, and the later rule wins', async () => {
    const blob = await fetch(`${base}/blob/a:b/c.txt`)
    expect(blob.headers.get('content-security-policy')).toBe('sandbox')
    expect(blob.headers.get('x-handler')).toBe('yes')
    const page = await fetch(`${base}/some/page`)
    expect(page.headers.get('content-security-policy')).toBe('site-wide')
  })

  test('a static file wins over the catch-all rewrite', async () => {
    const res = await fetch(`${base}/index.js`)
    expect(await res.text()).toBe('static')
    expect(res.headers.get('content-security-policy')).toBe('site-wide')
  })

  test('bodies are parsed as Cloud Functions parses them, keeping rawBody', async () => {
    await fetch(`${base}/demo-x/us-central1/doc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"p":"post/x"}',
    })
    expect(last()).toMatchObject({ body: { p: 'post/x' }, raw: '{"p":"post/x"}' })
    await fetch(`${base}/demo-x/us-central1/doc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([104, 105]),
    })
    expect(last().raw).toBe('hi')
    await fetch(`${base}/demo-x/us-central1/doc`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'plain',
    })
    expect(last()).toMatchObject({ body: 'plain', raw: 'plain' })
    await fetch(`${base}/demo-x/us-central1/doc`)
    expect(last().raw).toBe('')
  })

  test('a handler that throws, or rejects, is a 500, not a hung request', async () => {
    expect((await fetch(`${base}/boom`)).status).toBe(500)
    expect((await fetch(`${base}/demo-x/us-central1/later`)).status).toBe(500)
  })

  test('a rewrite to an endpoint that does not exist refuses to start', () => {
    expect(() =>
      localApp({ endpoints, hosting: { config: { rewrites: [{ source: '**', function: 'nope' }] }, root: dir } })
    ).toThrow('unknown endpoint: nope')
  })
})
