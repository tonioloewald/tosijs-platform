import { describe, test, expect } from 'bun:test'
import { embedJson, escapeText, renderDocument } from './document'

const evalEmbedded = (js: string) => new Function(`return ${js}`)()

describe('embedJson — data in a <script> cannot end the script', () => {
  test('a post containing </script> stays inert, and round-trips exactly', () => {
    const post = { content: 'x</script><script>alert(1)</script>y', code: '"key": 1' }
    const js = embedJson(post)
    expect(js).not.toContain('</script')
    expect(js).not.toContain('<')
    expect(evalEmbedded(js)).toEqual(post)
  })
  test('text that LOOKS like a key is not rewritten (the old regex corrupted it)', () => {
    const v = { content: 'set "title": "x" in JSON' }
    expect(evalEmbedded(embedJson(v))).toEqual(v)
  })
  test('JS line separators are escaped', () => {
    const v = { s: 'a\u2028b\u2029c' }
    const js = embedJson(v)
    expect(js).not.toMatch(/[\u2028\u2029]/)
    expect(evalEmbedded(js)).toEqual(v)
  })
})

describe('renderDocument', () => {
  const head = { title: 'A <b>title</b> & co', description: 'd', imageUrl: '', url: '/blog/x', type: 'article' }
  const html = renderDocument(head, { page: { path: 'blog' } }, 'https://loewald.com')

  test('the title is text, not markup', () => {
    expect(html).toContain('<title>A &lt;b&gt;title&lt;/b&gt; &amp; co</title>')
    expect(escapeText('</title><script>')).toBe('&lt;/title&gt;&lt;script&gt;')
  })
  test('social tags are absolute; no own image → logo and a small card', () => {
    expect(html).toContain('<meta property="og:url" content="https://loewald.com/blog/x">')
    expect(html).toContain('<meta property="og:image" content="https://loewald.com/logo.png">')
    expect(html).toContain('<meta name="twitter:card" content="summary">')
    expect(html).toContain('<meta property="og:type" content="article">')
  })
  test('an own image gives the large card', () => {
    const h = renderDocument({ ...head, imageUrl: 'https://cdn.test/a.webp' }, {}, 'https://loewald.com')
    expect(h).toContain('content="summary_large_image"')
    expect(h).toContain('<meta property="og:image" content="https://cdn.test/a.webp">')
  })
  test('the apple-touch-icon is the site icon, not a post image', () => {
    const h = renderDocument({ ...head, imageUrl: 'https://cdn.test/a.webp' }, {}, 'https://loewald.com')
    expect(h).toContain('<link rel="apple-touch-icon" href="/logo.png">')
  })
  test('embeds the data and loads the app', () => {
    expect(html).toContain('var prefetched = {"page":{"path":"blog"}}')
    expect(html).toContain('<script type="module" src="/index.js"></script>')
  })
})
