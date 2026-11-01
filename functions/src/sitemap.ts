import type { Handler } from './http'
import { log } from './log'
import compression from 'compression'

import { getDoc } from './doc'
import { dataStore } from './datastore'
import { isPublished } from '../shared/post'
import { optionsResponse } from './utilities'
import { serveSitemap } from './render/store'

const compressResponse = compression()

const xmlUrl = (url: string) => `<url><loc>${url}</loc></url>`

export const handleSitemap: Handler = async (req, res) => {
  if (optionsResponse(req, res)) {
    return
  }

  // Render on store (D23): the stored sitemap, re-rendered only when a post's
  // published state, path or date changes.
  if (process.env.RENDER_ON_STORE === 'true') {
    const xml = await serveSitemap()
    compressResponse(req, res, () => {
      res.header('Content-Type', 'application/xml')
      res.header('Cache-Control', 'public, max-age=300, s-maxage=3600')
      res.status(200).send(xml)
    })
    return
  }

  // Load app config to get host.
  //
  // The ternary used to test only `.ok`, so when config/app EXISTS but carries no
  // `host` field the undefined value won over the fallback — and every URL in the
  // sitemap came out as `https://undefined/...`. All 850 of them, silently, for as
  // long as this has been deployed. Fall back on the VALUE, not on the lookup.
  const appConfigResult = await getDoc(req, res, 'config/app')
  const host =
    (appConfigResult.ok ? appConfigResult.data.host : undefined) || req.hostname

  const staticUrls = [`https://${host}/`, `https://${host}/blog/`]

  const postUrls: string[] = []
  try {
    // Every post, oldest first, a page at a time (the store port's scan; this
    // was a Firestore stream over the same `orderBy('date')`).
    for await (const page of dataStore.scan('post', { orderBy: 'date asc' }, 500)) {
      for (const { data: post } of page) {
        // Drafts must not reach the sitemap. Unpublished posts are deliberately
        // READABLE by direct link (so a draft can be shared for comment) — the
        // property that matters is that they are not findable by ACCIDENT, and
        // handing them to crawlers is the most direct way to break that.
        // Ordering by `date` does not filter them out: Firestore only skips
        // documents where the field is ABSENT, and `unpublish()` writes `''`.
        if (!isPublished(post)) continue

        const date = new Date(post.date as string)
        if (isNaN(date.valueOf())) continue // never emit /blog/NaN/NaN/NaN/...

        postUrls.push(
          // getMonth() is 0-based; the client's own linkFromRef adds 1, and these
          // URLs were off by a month against every link the site itself generates.
          `https://${host}/blog/${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}/${
            post.path
          }`
        )
      }
    }
  } catch (error) {
    log.error('Sitemap stream error:', error)
    if (!res.headersSent) {
      res.status(500).send('Error generating sitemap')
    }
    return
  }

  const xml =
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    `<!-- last updated ${new Date().toISOString()} -->` +
    staticUrls.map(xmlUrl).join('') +
    postUrls.map(xmlUrl).join('') +
    '</urlset>'

  compressResponse(req, res, () => {
    res.header('Content-Type', 'application/xml')
    res.send(xml).status(200)
  })
}
