/**
 * Every JavaScript module the client can load, followed from its entry, and
 * whatever is wrong with any of them.
 *
 * The client is split into chunks (`bun build --splitting`); the editor, the
 * Markdown viewer and the tjs runtime load on demand. A chunk that 404s, or is
 * answered by the `**` → prefetch rewrite with HTML, fails only when someone
 * opens the editor, as "Importing a module script failed", and Safari keeps
 * that failure until the page is reloaded. So the deploy check walks the whole
 * graph, and a test walks the local build.
 *
 * Only relative specifiers (`./x.js`) are followed: they are the chunks. Bare
 * and absolute URLs (CDN fallbacks) are not ours to check.
 */

/** Relative module specifiers in a built chunk: static imports, re-exports and import(). */
export function relativeImports(source) {
  const found = new Set()
  const patterns = [
    /\bfrom\s*["'](\.\.?\/[^"']+)["']/g,
    /\bimport\s*["'](\.\.?\/[^"']+)["']/g,
    /\bimport\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g,
  ]
  for (const pattern of patterns)
    for (const m of source.matchAll(pattern)) found.add(m[1])
  return [...found]
}

/**
 * Walk the module graph from `entry` (a URL). `load(url)` returns
 * `{ status, contentType, text }`. Resolves to `{ modules, problems }`:
 * every URL reached, and one line per module that is missing, not
 * JavaScript, or failed to load, naming a module that imports it.
 */
export async function moduleGraph(entry, load) {
  const seen = new Map([[entry, null]])
  const queue = [entry]
  const problems = []
  while (queue.length) {
    const url = queue.shift()
    const from = seen.get(url)
    const via = from ? ` (imported by ${new URL(from).pathname})` : ''
    let response
    try {
      response = await load(url)
    } catch (e) {
      problems.push(
        `${new URL(url).pathname}: ${e instanceof Error ? e.message : e}${via}`
      )
      continue
    }
    if (response.status !== 200) {
      problems.push(`${new URL(url).pathname}: ${response.status}${via}`)
      continue
    }
    if (!/javascript/.test(response.contentType ?? '')) {
      problems.push(
        `${new URL(url).pathname}: served as ${
          response.contentType || 'no type'
        }, not JavaScript${via}`
      )
      continue
    }
    for (const specifier of relativeImports(response.text)) {
      const next = new URL(specifier, url).href
      if (!seen.has(next)) {
        seen.set(next, url)
        queue.push(next)
      }
    }
  }
  return { modules: [...seen.keys()], problems }
}

/** `load` for a deployed site. */
export const fetchModule = async (url) => {
  const r = await fetch(url)
  return {
    status: r.status,
    contentType: r.headers.get('content-type') ?? '',
    text: r.status === 200 ? await r.text() : '',
  }
}
