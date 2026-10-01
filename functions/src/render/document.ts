/**
 * Assemble the HTML document a route is served as (D23). PURE: head options,
 * the data to embed, and the site's origin in; a string out. No I/O, so it
 * runs identically at render-on-store time and at serve time, and is tested
 * without emulators.
 *
 * The page body is empty on purpose: the client (index.js) renders it from
 * `window.prefetched`. What matters for SEO and social previews is the head.
 */
import { DOCTYPE, elements } from '../elements'
import { absoluteUrl } from '../social-meta'

export interface HeadOptions {
  title: string
  description: string
  /** The page's own image; empty → the site logo, and a small card. */
  imageUrl: string
  /** Canonical-ish URL for og:url; relative is resolved against the origin. */
  url: string
  type: string
}

const ICON_URL = '/logo.png'
const MANIFEST_URL = '/manifest.json'
const SCRIPT_URL = '/index.js'
const DEFAULT_IMAGE = '/logo.png'

/**
 * Data embedded in a <script> must not be able to END the script. JSON alone
 * does not prevent that: a post containing `</script><script>…` would break
 * out and run as the site (an author → owner escalation). Escaping `<` (and the
 * two line separators JS treats as newlines) keeps it inert and still valid
 * JSON-as-JS. Keys stay quoted: the old code unquoted them with a regex that
 * also rewrote any `"word":` INSIDE strings, silently corrupting content.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** Text content: the element helper does not escape children, and a title is author input. */
export const escapeText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function renderDocument(head: HeadOptions, prefetched: unknown, origin: string): string {
  const { html, head: headEl, meta, title, link, script, body } = elements
  const pageUrl = absoluteUrl(head.url, origin)
  const ownImage = Boolean(head.imageUrl)
  const imageUrl = absoluteUrl(head.imageUrl || DEFAULT_IMAGE, origin)
  return (
    DOCTYPE +
    html(
      { lang: 'en' },
      headEl(
        meta({ charset: 'utf-8' }),
        title(escapeText(head.title)),
        meta({ name: 'description', content: head.description }),
        meta({ property: 'og:title', content: head.title }),
        meta({ property: 'og:description', content: head.description }),
        meta({ property: 'og:url', content: pageUrl }),
        meta({ property: 'og:image', content: imageUrl }),
        meta({ property: 'og:type', content: head.type || 'website' }),
        meta({ name: 'twitter:card', content: ownImage ? 'summary_large_image' : 'summary' }),
        link({ rel: 'icon', href: '/favicon.ico' }),
        meta({ name: 'viewport', content: 'width=device-width, initial-scale=1' }),
        meta({ name: 'theme-color', content: '#000000' }),
        link({ rel: 'apple-touch-icon', href: ICON_URL }),
        link({ rel: 'manifest', href: MANIFEST_URL }),
        script({}, `var prefetched = ${embedJson(prefetched)}`),
        script({ type: 'module', src: SCRIPT_URL })
      ),
      body()
    )
  )
}
