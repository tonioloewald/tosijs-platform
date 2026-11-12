/**
 * The server's copy of a post (functions/src/render/markdown.ts, #4063) must
 * match what the client's <tosi-md> renders: same `marked` version, same
 * sanitizing. Otherwise a crawler reads a different post than a person does,
 * or the server serves something the client would have stripped.
 */
import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { tosiMd } from 'tosijs-ui/markdown-viewer'
import { renderMarkdown } from '../functions/src/render/markdown'

const SAMPLES = [
  '# Heading\n\nA paragraph with *em*, **strong**, `code` and a [link](https://loewald.com/blog/x).',
  '- one\n- two\n\n1. first\n2. second\n\n> a quote\n\n---',
  '| a | b |\n|---|---|\n| 1 | 2 |',
  '```js\nconst a = 1 < 2 && "x"\n```',
  '![alt text](https://loewald.com/blob/blog:public/pic "title")',
  // Older posts are HTML.
  '<p class="lede">An <em>old</em> post, <a href="/blog/2014/1/1/x" target="_blank">linked</a>.</p>\n<p>Second &amp; last.</p>',
  // What the sanitizer must remove, identically on both sides.
  '<script>alert(1)</script><img src="x.png" onerror="alert(2)"> [a](javascript:alert(3)) <a href="data:image/png;base64,AA">d</a>',
  '<tosi-example>const x = 1</tosi-example> <button is="x-y">b</button>',
]

// Both serializations through the same parser, so only content can differ.
const normal = (html: string) => {
  const t = document.createElement('template')
  t.innerHTML = html
  return t.innerHTML.replace(/>\s+</g, '><').trim()
}

const clientRender = (source: string) => {
  const el = tosiMd({ value: source })
  document.body.append(el)
  el.render()
  const html = el.innerHTML
  el.remove()
  return html
}

test('server and client use the same marked', () => {
  const version = (dir: string) => JSON.parse(readFileSync(`${dir}/node_modules/marked/package.json`, 'utf8')).version
  expect(version('functions')).toBe(version('.'))
})

for (const [i, source] of SAMPLES.entries()) {
  test(`sample ${i}: the server renders what the client does`, () => {
    expect(normal(renderMarkdown(source))).toBe(normal(clientRender(source)))
  })
}
