/**
 * SSR renders as the PUBLIC (decision: Tonio, 2026-09-10).
 *
 * "SSR is going to be public. The whole point of SSR is SEO. We don't need it
 * for speed, we are fast lean and cache friendly."
 *
 * Server-rendered output is shared and cached, so rendering it with the caller's
 * rights lets a privileged visitor bake their private view into the page
 * everyone else reads. blog.ts's prefetch handler builds its post pools with
 * whatever roles it is handed and writes them to config/blog-cache — which is
 * publicly readable — while author/owner hold `list: ALL` on post.
 *
 * Enforced at the single invocation point in getPrefetchData, so a contributed
 * handler cannot render privileged content whoever wrote it. These tests pin the
 * helper that makes that true.
 *
 * Run: cd functions && bun test src/collections/ssr-public.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { asPublicRequest } from '../public-request'

const reqLike = (headers: Record<string, unknown>, extra = {}) =>
  ({ headers, method: 'GET', query: { p: 'post' }, ...extra }) as never

describe('asPublicRequest strips credentials', () => {
  test('an Authorization header is removed', () => {
    const pub = asPublicRequest(reqLike({ authorization: 'Bearer secret-token' }))
    expect(pub.headers.authorization).toBeUndefined()
  })

  test('the ORIGINAL request is not mutated', () => {
    // The caller's own request must keep working — this is a view, not a change.
    const original = reqLike({ authorization: 'Bearer secret-token' })
    asPublicRequest(original)
    expect(original.headers.authorization).toBe('Bearer secret-token')
  })

  test('other headers survive', () => {
    const pub = asPublicRequest(
      reqLike({ authorization: 'Bearer x', host: 'loewald.com', 'accept-language': 'en' })
    )
    expect(pub.headers.host).toBe('loewald.com')
    expect(pub.headers['accept-language']).toBe('en')
  })

  test('a request with no credentials is unchanged in effect', () => {
    const pub = asPublicRequest(reqLike({ host: 'loewald.com' }))
    expect(pub.headers.authorization).toBeUndefined()
    expect(pub.headers.host).toBe('loewald.com')
  })
})

describe('the rest of the request still works', () => {
  test('non-header properties are inherited', () => {
    const pub = asPublicRequest(reqLike({ authorization: 'Bearer x' }))
    expect(pub.method).toBe('GET')
    expect((pub as unknown as { query: { p: string } }).query.p).toBe('post')
  })

  test('prototype methods survive (express request methods are not lost)', () => {
    const original = reqLike({ authorization: 'Bearer x' }, {
      get(name: string) {
        return `header:${name}`
      },
    })
    const pub = asPublicRequest(original)
    expect((pub as unknown as { get(n: string): string }).get('host')).toBe(
      'header:host'
    )
  })
})
