/**
 * A post's body as HTML, for the page a fetcher without JavaScript reads
 * (#4063). The client renders the same post with tosijs-ui's <tosi-md>:
 * `marked` with default options, then tosijs-kilpi's sanitizer. This starts the
 * same way (same marked version, same kilpi, same URL rules), so it shows the
 * same text, links and images, and nothing the client would strip.
 *
 * It does NOT hand on what the parser serializes. The browser sanitizes with
 * the parser that then displays the result; here linkedom parses, and the
 * visitor's browser re-parses whatever we emit. linkedom is not a
 * spec-compliant HTML parser, and a gap between the parser that sanitized and
 * the one that renders is how mutation XSS gets through sanitizers. So the
 * output is written fresh from an allowlist: text-structure tags and a few
 * attributes, every text and value escaped, nothing from raw-text or foreign
 * elements (script, style, svg, math…). HTML that plain means the same thing to
 * every parser. It is a plainer copy than the client renders; the client
 * replaces it anyway.
 *
 * This matters more than in the browser: the HTML is served as the site, to
 * every visitor, before any client code runs. A script in a post (an author
 * account taken over) would run for everyone.
 *
 * kilpi needs a DOM; linkedom supplies one, only while kilpi runs. The root is
 * a plain element, not a <template>: linkedom's tree walker does not enter
 * template content, so kilpi would silently sanitize nothing.
 */
import { marked } from 'marked'
import { elements } from '../elements'
import { escapeText } from './document'

// The little of linkedom used here. Its own type declarations clash with the
// DOM library's, so they are not imported.
interface Dom {
  document: Document
  Element: unknown
}
type Kilpi = typeof import('tosijs-kilpi')

/**
 * Run `fn` with linkedom standing in for the browser globals kilpi uses, then
 * put back whatever was there. Left in place, a global `document` would make
 * other server code (and libraries) believe it runs in a browser.
 */
function withDomGlobals<T>(dom: Dom, fn: () => T): T {
  const globals = globalThis as Record<string, unknown>
  const stand: Record<string, unknown> = {
    document: dom.document,
    Element: dom.Element,
    NodeFilter: { SHOW_ELEMENT: 1 },
  }
  const saved = Object.keys(stand).map((name) => [name, Object.getOwnPropertyDescriptor(globals, name)] as const)
  for (const [name, value] of Object.entries(stand)) globals[name] = value
  try {
    return fn()
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globals, name, descriptor)
      else delete globals[name]
    }
  }
}

/**
 * Loaded on first use, not at import: every function shares this codebase,
 * and linkedom would add to each one's cold start. kilpi reads
 * `Element.prototype` when it loads, so it loads under the stand-ins.
 */
let tools: { dom: Dom; kilpi: Kilpi } | undefined
function domTools() {
  if (!tools) {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { parseHTML } = require('linkedom') as { parseHTML(html: string): Dom }
    const dom = parseHTML('<!doctype html><html><body></body></html>')
    const kilpi = withDomGlobals(dom, () => require('tosijs-kilpi') as Kilpi)
    /* eslint-enable @typescript-eslint/no-var-requires */
    tools = { dom, kilpi }
  }
  return tools
}

/** Emitted as themselves (with only the attributes below); anything else is unwrapped. */
const ALLOWED_TAGS = new Set(
  (
    'a abbr b blockquote br caption cite code dd del dfn div dl dt em figcaption figure ' +
    'h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strong sub sup ' +
    'table tbody td tfoot th thead time tr u ul'
  ).split(' ')
)
const VOID_TAGS = new Set(['br', 'hr', 'img'])
/** Dropped with everything in them: code, styling, foreign content, forms. */
const DROPPED_TAGS = new Set(
  'script style template noscript iframe object embed svg math textarea select option title head form'.split(' ')
)
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  time: ['datetime'],
}

const escapeValue = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const escapeData = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const TEXT_NODE = 3
const ELEMENT_NODE = 1

function serialize(node: Node, isSafeNavigationUrl: (url: string) => boolean): string {
  if (node.nodeType === TEXT_NODE) return escapeData(node.textContent ?? '')
  if (node.nodeType !== ELEMENT_NODE) return '' // comments, processing instructions
  const el = node as Element
  const tag = el.localName.toLowerCase()
  if (DROPPED_TAGS.has(tag)) return ''
  const inner = () => Array.from(el.childNodes, (child) => serialize(child, isSafeNavigationUrl)).join('')
  if (!ALLOWED_TAGS.has(tag)) return inner() // custom elements, font, center…: their content only
  const attrs = (ALLOWED_ATTRIBUTES[tag] ?? [])
    .filter((name) => el.hasAttribute(name))
    .filter((name) => name !== 'href' || isSafeNavigationUrl(el.getAttribute(name) ?? ''))
    .map((name) => ` ${name}="${escapeValue(el.getAttribute(name) ?? '')}"`)
    .join('')
  return VOID_TAGS.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${inner()}</${tag}>`
}

/** Markdown (or the HTML many older posts are written in) → plain, safe HTML. */
export function renderMarkdown(source: string): string {
  const { dom, kilpi } = domTools()
  const root = dom.document.createElement('div')
  root.innerHTML = marked.parse(String(source ?? ''), { async: false }) as string
  // kilpi's URL rules for src (raster data: images allowed, svg not), as the client applies them.
  withDomGlobals(dom, () => kilpi.sanitizeInPlace(root))
  return Array.from(root.childNodes, (child) => serialize(child, kilpi.isSafeNavigationUrl)).join('')
}

/**
 * The post as the reading view shows it: title, body, author and date. Marked
 * `data-ssr` so the client removes it when it renders the page itself.
 */
export function postBodyHtml(post: { title?: unknown; content?: unknown; author?: unknown; date?: unknown }): string {
  const { article, h1, p, time } = elements
  const when = new Date(String(post.date ?? ''))
  const date = isNaN(when.valueOf())
    ? ''
    : time(
        { datetime: when.toISOString() },
        when.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
      )
  const byline = [post.author ? escapeText(String(post.author)) : '', date].filter(Boolean).join(', ')
  return article(
    { 'data-ssr': true },
    h1(escapeText(String(post.title ?? ''))),
    renderMarkdown(String(post.content ?? '')),
    byline ? p({ class: 'byline' }, `— ${byline}`) : ''
  )
}
