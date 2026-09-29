/**
 * Social-preview helpers for SSR (prefetch.ts, blog.ts).
 *
 * Open Graph consumers (Facebook, LinkedIn, Slack, iMessage) want ABSOLUTE
 * `og:url` / `og:image`; a relative one is ignored or resolved against the
 * wrong host, so a shared post showed no image. And posts are Markdown, so the
 * "first image in the post" fallback must understand `![alt](src)` as well as
 * `<img src>`.
 */

/** The first image in a post body — Markdown or HTML, whichever comes first. */
export function firstImage(content: string | undefined): string | undefined {
  if (!content) return undefined
  const candidates = [
    /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(content),
    /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i.exec(content),
  ].filter((m): m is RegExpExecArray => m !== null)
  candidates.sort((a, b) => a.index - b.index)
  return candidates[0]?.[1]
}

/**
 * The public origin a request arrived on. Firebase Hosting forwards the
 * site's host in `x-forwarded-host`; a direct call to the function falls back
 * to its own host. Only the requester sees the result (SSR HTML is not cached
 * here), so a spoofed header only misleads the spoofer.
 */
export function siteOrigin(headers: Record<string, unknown>): string {
  const pick = (v: unknown) => (Array.isArray(v) ? v[0] : v)
  const raw = String(pick(headers['x-forwarded-host']) ?? pick(headers.host) ?? '')
  const host = raw.split(',')[0].trim()
  return /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) ? `https://${host}` : ''
}

/** Resolve `u` against `origin`; returns `u` unchanged if it cannot be. */
export function absoluteUrl(u: string, origin: string): string {
  if (!origin) return u
  try {
    return new URL(u, origin).href
  } catch {
    return u
  }
}
