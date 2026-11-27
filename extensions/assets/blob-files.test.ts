/**
 * `blobFiles`: what it sends to /blob and /docs, and what it makes of the
 * answers. The host's side of the same wire is tested in
 * functions/src/blob-handler.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import { blobFiles, type BlobFilesOptions } from './blob-files'

interface Sent {
  url: string
  method: string
  auth: string | null
  contentType: string | null
  body: unknown
}

const host = (answer: (sent: Sent, n: number) => Response) => {
  const sent: Sent[] = []
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    const s: Sent = {
      url,
      method: init.method ?? 'GET',
      auth: headers.get('Authorization'),
      contentType: headers.get('Content-Type'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    }
    sent.push(s)
    return answer(s, sent.length)
  }) as unknown as typeof globalThis.fetch
  return { sent, fetch }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const files = (
  fetch: typeof globalThis.fetch,
  extra: Partial<BlobFilesOptions> = {}
) =>
  blobFiles({
    serviceUrl: 'https://host.test/',
    getToken: () => 'tok',
    fetch,
    ...extra,
  })

describe('blobFiles', () => {
  test('lists an area from /docs, sorted by name, with the token', async () => {
    const h = host(() =>
      json([{ path: 'b.png', contentType: 'image/png' }, { path: 'a/c.pdf' }])
    )
    expect(await files(h.fetch).list('blog:public')).toEqual([
      { name: 'a/c.pdf', path: 'blog:public/a/c.pdf', contentType: undefined },
      { name: 'b.png', path: 'blog:public/b.png', contentType: 'image/png' },
    ])
    const url = new URL(h.sent[0].url)
    expect(url.pathname).toBe('/docs')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      p: 'blog:public',
      c: '2000',
      f: 'path,contentType',
    })
    expect(h.sent[0].auth).toBe('Bearer tok')
  })

  test('a refused listing throws with the host’s reason', async () => {
    const h = host(() => json({ message: 'no such collection' }, 404))
    await expect(files(h.fetch).list('blog:private')).rejects.toThrow(
      'no such collection'
    )
  })

  test('a folder that is not a storage area is refused, and nothing is sent', async () => {
    const h = host(() => json([]))
    await expect(files(h.fetch).list('public')).rejects.toThrow(
      'public is not a storage area'
    )
    await expect(
      files(h.fetch).upload(new Blob(['x']), 'public/a.png')
    ).rejects.toThrow('not a storage area')
    expect(h.sent).toEqual([])
  })

  test('uploads to a clean name, with the body’s type, and returns the path it got', async () => {
    const h = host(() => json({ ok: true }, 201))
    const path = await files(h.fetch).upload(
      new Blob(['x'], { type: 'image/webp' }),
      'blog:public/my pics/My Pic.webp'
    )
    expect(path).toBe('blog:public/my-pics/My-Pic.webp')
    expect(h.sent[0]).toMatchObject({
      url: 'https://host.test/blob/blog:public/my-pics/My-Pic.webp',
      method: 'PUT',
      contentType: 'image/webp',
      auth: 'Bearer tok',
    })
  })

  test('a refused upload throws with the host’s reason', async () => {
    const h = host(() => json({ message: 'type not allowed' }, 400))
    await expect(
      files(h.fetch).upload(
        new Blob(['<p>'], { type: 'text/html' }),
        'blog:public/a.html'
      )
    ).rejects.toThrow('type not allowed')
  })

  test('a write refused with a token is retried once with a fresh token', async () => {
    const tokens: boolean[] = []
    const h = host((_s, n) =>
      n === 1 ? json({}, 403) : new Response(null, { status: 204 })
    )
    const ok = await files(h.fetch, {
      getToken: (refresh) => {
        tokens.push(refresh)
        return refresh ? 'fresh' : 'stale'
      },
    }).remove('blog:public/a.png')
    expect(ok).toBe(true)
    expect(tokens).toEqual([false, true])
    expect(h.sent.map((s) => [s.method, s.auth])).toEqual([
      ['DELETE', 'Bearer stale'],
      ['DELETE', 'Bearer fresh'],
    ])
  })

  test('signed out, nothing is retried and no Authorization is sent', async () => {
    const h = host(() => json({}, 403))
    expect(
      await files(h.fetch, { getToken: () => null }).remove('blog:public/a.png')
    ).toBe(false)
    expect(h.sent.length).toBe(1)
    expect(h.sent[0].auth).toBeNull()
  })

  test('a move is one request to /blob, the new name cleaned; across a non-area it is refused', async () => {
    const h = host(() => json({ ok: true }))
    expect(
      await files(h.fetch).move('blog:public/a.png', 'blog:public/b c.png')
    ).toBe(true)
    expect(h.sent[0]).toMatchObject({
      url: 'https://host.test/blob',
      method: 'POST',
      body: {
        op: 'move',
        from: { area: 'blog:public', path: 'a.png' },
        to: { area: 'blog:public', path: 'b-c.png' },
      },
    })
    expect(await files(h.fetch).move('public/a.png', 'blog:public/a.png')).toBe(
      false
    )
    expect(h.sent.length).toBe(1)
  })

  test('a file’s address is under /blob/ by default, or the host’s own base', () => {
    const h = host(() => json({}))
    expect(files(h.fetch).url('blog:public/a/b.png')).toBe(
      '/blob/blog:public/a/b.png'
    )
    expect(
      files(h.fetch, { fileBase: 'https://cdn.test/blob/' }).url(
        'assets:public/x.pdf'
      )
    ).toBe('https://cdn.test/blob/assets:public/x.pdf')
  })
})
