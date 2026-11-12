/**
 * A post's body as HTML, for the page a fetcher without JavaScript reads
 * (#4063). The client renders the same post with tosijs-ui's <tosi-md>, and
 * this does what it does, in the same order and with the same libraries:
 * `marked` with default options, then tosijs-kilpi's sanitizer, then custom
 * elements unwrapped and every href held to the navigation rule. So the server
 * shows what the client will, and cannot show anything the client would strip.
 *
 * Sanitizing matters more here than in the browser: this HTML is served as
 * the site to every visitor, so a script in a post (an author account taken
 * over) would run for everyone before any client code did.
 *
 * kilpi needs a DOM; linkedom supplies one, only while kilpi runs. The root is a plain
 * element, not a <template>: linkedom's tree walker does not enter template
 * content, so kilpi would silently sanitize nothing.
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

/** tosi-md unwraps these even when a host allows custom elements; we allow none. */
const isCustomElement = (el: Element) => el.localName.includes('-')

/** Markdown (or the HTML many older posts are written in) → sanitized HTML. */
export function renderMarkdown(source: string): string {
  const { dom, kilpi } = domTools()
  const root = dom.document.createElement('div')
  root.innerHTML = marked.parse(String(source ?? ''), { async: false }) as string
  withDomGlobals(dom, () => kilpi.sanitizeInPlace(root))
  for (const el of [...root.querySelectorAll('*')]) {
    el.removeAttribute('is')
    if (isCustomElement(el)) el.replaceWith(...el.childNodes)
  }
  for (const el of root.querySelectorAll('[href]')) {
    if (!kilpi.isSafeNavigationUrl(el.getAttribute('href') || '')) el.removeAttribute('href')
  }
  return root.innerHTML
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
