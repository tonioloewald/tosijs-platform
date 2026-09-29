import { describe, test, expect } from 'bun:test'
import { absoluteUrl, firstImage, siteOrigin } from './social-meta'

describe('firstImage', () => {
  test('finds a Markdown image — posts are Markdown', () => {
    expect(firstImage('intro\n\n![demo site](https://x.test/a%2Fb.png?alt=media)\n')).toBe('https://x.test/a%2Fb.png?alt=media')
  })
  test('with a title, or angle brackets', () => {
    expect(firstImage('![a](/stored/blog/p.png "caption")')).toBe('/stored/blog/p.png')
    expect(firstImage('![a](<https://x.test/p.png>)')).toBe('https://x.test/p.png')
  })
  test('finds an HTML image', () => {
    expect(firstImage('<p><img alt="x" src="/stored/blog/q.webp"></p>')).toBe('/stored/blog/q.webp')
  })
  test('whichever comes first wins', () => {
    expect(firstImage('<img src="/first.png"> then ![b](/second.png)')).toBe('/first.png')
    expect(firstImage('![a](/first.png) then <img src="/second.png">')).toBe('/first.png')
  })
  test('a plain link is not an image; nothing → undefined', () => {
    expect(firstImage('[a link](https://x.test/page)')).toBeUndefined()
    expect(firstImage(undefined)).toBeUndefined()
  })
})

describe('siteOrigin', () => {
  test('prefers the host Firebase Hosting forwards', () => {
    expect(siteOrigin({ 'x-forwarded-host': 'loewald.com', host: 'prefetch-abc.a.run.app' })).toBe('https://loewald.com')
  })
  test('falls back to the function host; takes the first of a list', () => {
    expect(siteOrigin({ host: 'prefetch-abc.a.run.app' })).toBe('https://prefetch-abc.a.run.app')
    expect(siteOrigin({ 'x-forwarded-host': 'loewald.com, proxy.internal' })).toBe('https://loewald.com')
  })
  test('refuses anything that is not a bare host', () => {
    expect(siteOrigin({ host: 'evil.test/"><script>' })).toBe('')
    expect(siteOrigin({})).toBe('')
  })
})

describe('absoluteUrl', () => {
  test('resolves relative paths; keeps absolute ones', () => {
    expect(absoluteUrl('/blog/it-begins', 'https://loewald.com')).toBe('https://loewald.com/blog/it-begins')
    expect(absoluteUrl('https://cdn.test/x.png', 'https://loewald.com')).toBe('https://cdn.test/x.png')
  })
  test('no origin → unchanged', () => {
    expect(absoluteUrl('/logo.png', '')).toBe('/logo.png')
  })
})
