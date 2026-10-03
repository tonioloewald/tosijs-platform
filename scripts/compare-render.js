#!/usr/bin/env bun
/**
 * Render on store (D23): does the new path serve what the old one did?
 *
 * For every URL in the sitemap (plus edge cases), fetch `window.prefetched`
 * from the OLD per-request path (`/prefetchData?url=`) and from the NEW one
 * (`&engine=store`), and report every difference. Only the render timestamp
 * is ignored. Read-only on the old path; the new path renders and stores
 * artifacts lazily, which is what it does in production anyway.
 *
 *   bun scripts/compare-render.js --alias sandbox [--limit 50] [--verbose]
 */
import * as lib from './sandbox-lib.js'

const { has, val } = lib.parseArgs(process.argv)
const alias = val('alias') ?? 'sandbox'
const projectId = lib.readRc().projects?.[alias]
if (!projectId) throw new Error(`no project for alias ${alias}`)
const BASE = `https://us-central1-${projectId}.cloudfunctions.net`
const limit = Number(val('limit') ?? Infinity)

const sitemap = await (await fetch(`https://${projectId}.web.app/sitemap.xml`)).text()
const fromSitemap = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname)
const urls = [
  ...new Set([...fromSitemap.slice(0, limit), '/', '/blog/', '/no-such-page', '/blog/no-such-post']),
]
// A short-form post link, as people share them.
const aPost = fromSitemap.find((u) => u.split('/').length > 5)
if (aPost) urls.push(`/blog/${aPost.split('/').pop()}`)

const IGNORED = new Set(['blogDataTimestamp'])
const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) if (!IGNORED.has(k)) out[k] = strip(v[k])
    return out
  }
  return v
}
function diff(a, b, path = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out.push(`${path}${k}: only NEW`)
      else if (!(k in b)) out.push(`${path}${k}: only OLD`)
      else diff(a[k], b[k], `${path}${k}.`, out)
    }
    return out
  }
  out.push(`${path.replace(/\.$/, '')}: OLD ${JSON.stringify(a)?.slice(0, 80)} ≠ NEW ${JSON.stringify(b)?.slice(0, 80)}`)
  return out
}

const getJson = async (u) => {
  const r = await fetch(u)
  return { status: r.status, body: await r.json().catch(() => null) }
}

let same = 0
const different = []
const queue = [...urls]
// Stay under the platform's rate limit (100 requests/minute per IP): two
// requests per URL, one URL every 1.5s.
const PACE_MS = 1500
await Promise.all(
  Array.from({ length: 1 }, async () => {
    while (queue.length) {
      await new Promise((r) => setTimeout(r, PACE_MS))
      const url = queue.shift()
      const q = encodeURIComponent(url)
      const oldR = await getJson(`${BASE}/prefetchData?url=${q}`)
      const newR = await getJson(`${BASE}/prefetchData?url=${q}&engine=store`)
      // A refusal is never "identical": two 429 bodies match each other (the
      // first version of this script counted them as agreement).
      const d =
        oldR.status !== 200 || (newR.status !== 200 && newR.status !== 404)
          ? [`status: OLD ${oldR.status} NEW ${newR.status}`]
          : diff(strip(oldR.body), strip(newR.body))
      if (!d.length) same++
      else different.push({ url, statuses: `${oldR.status}/${newR.status}`, d })
    }
  })
)

console.log(`${urls.length} URLs: ${same} identical, ${different.length} different`)
const tally = new Map()
for (const { d } of different) for (const line of d) {
  const kind = line.replace(/post\/path=[^.:]+/g, 'post/path=…').replace(/: OLD .*/, ': value differs')
  tally.set(kind, (tally.get(kind) ?? 0) + 1)
}
for (const [kind, n] of [...tally].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(4)}  ${kind}`)
if (has('verbose')) for (const x of different.slice(0, 10)) console.log(x.url, x.statuses, '\n   ' + x.d.slice(0, 8).join('\n   '))
process.exit(different.length ? 1 : 0)
