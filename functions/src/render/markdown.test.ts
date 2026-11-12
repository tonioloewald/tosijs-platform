/**
 * A post's server-rendered HTML (#4063): sanitized as the client sanitizes,
 * and no browser globals left behind on the server.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { renderMarkdown, postBodyHtml } from './markdown'

describe('renderMarkdown', () => {
  test('renders markdown, and passes through the HTML older posts are written in', () => {
    expect(renderMarkdown('# Hi\n\nA [link](https://loewald.com/x).')).toBe(
      '<h1>Hi</h1>\n<p>A <a href="https://loewald.com/x">link</a>.</p>\n'
    )
    expect(renderMarkdown('<p class="lede">Old <em>post</em></p>')).toBe('<p>Old <em>post</em></p>')
  })

  test('nothing that runs survives', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script><img src="x.png" onerror="alert(2)"><iframe src="https://evil.test"></iframe>' +
        '\n\n[a](javascript:alert(3)) <a href="vbscript:x">b</a>'
    )
    expect(html).not.toMatch(/<script|onerror|<iframe|javascript:|vbscript:/i)
    expect(html).toContain('<img src="x.png">')
  })

  test('a link never carries a data: URL; an image may', () => {
    const html = renderMarkdown('<a href="data:image/png;base64,AA">d</a> <img src="data:image/png;base64,AA">')
    expect(html).toContain('<a>d</a>')
    expect(html).toContain('<img src="data:image/png;base64,AA">')
  })

  test('custom and unlisted elements are unwrapped, their text kept', () => {
    const html = renderMarkdown('<tosi-example>const x = 1</tosi-example> <tosi-md sanitize="off">raw</tosi-md> <button is="x-y">b</button>')
    expect(html).toBe('<p>const x = 1 raw b</p>\n')
  })

  test('only allowlisted attributes, every value escaped', () => {
    expect(renderMarkdown(`<a href="/x" title='a" onmouseover="alert(1)' class="c" style="x" id="i">l</a>`)).toBe(
      '<p><a href="/x" title="a&quot; onmouseover=&quot;alert(1)">l</a></p>\n'
    )
  })

  test('nothing from foreign or raw-text content, where parsers disagree (mutation XSS)', () => {
    const html = renderMarkdown(
      '<svg><style><img src=x onerror=alert(1)></style></svg>' +
        '<math><mtext><table><mglyph><style><img src=x onerror=alert(2)>' +
        '<noscript><p title="</noscript><img src=x onerror=alert(3)>"></noscript>' +
        '<!--><img src=x onerror=alert(4)>-->'
    )
    expect(html).not.toMatch(/onerror|<svg|<math|<style|<noscript|<!--/i)
  })

  test('text is escaped even where the parser kept it raw', () => {
    expect(renderMarkdown('<p>a &lt;script&gt; b</p>')).toBe('<p>a &lt;script&gt; b</p>')
  })

  test('code is escaped, not interpreted', () => {
    expect(renderMarkdown('```html\n<script>alert(1)</script>\n```')).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('leaves no browser globals behind', () => {
    renderMarkdown('# again')
    const g = globalThis as Record<string, unknown>
    expect([typeof g.document, typeof g.Element, typeof g.NodeFilter]).toEqual(['undefined', 'undefined', 'undefined'])
  })
})

describe('postBodyHtml', () => {
  test('title, body, author and a fixed-format date, marked for the client to remove', () => {
    expect(postBodyHtml({ title: 'A <b>title</b>', content: 'Hello', author: 'Tonio', date: '2026-11-11T08:00:00Z' })).toBe(
      '<article data-ssr><h1>A &lt;b&gt;title&lt;/b&gt;</h1><p>Hello</p>\n' +
        '<p class="byline">— Tonio, <time datetime="2026-11-11T08:00:00.000Z">November 11, 2026</time></p></article>'
    )
  })

  test('no byline without author or date', () => {
    expect(postBodyHtml({ title: 'T', content: 'x' })).toBe('<article data-ssr><h1>T</h1><p>x</p>\n</article>')
  })
})
