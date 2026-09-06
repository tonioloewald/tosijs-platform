import { onRequest } from 'firebase-functions/v2/https'
import * as functions from 'firebase-functions'
import compression from 'compression'

import { getDoc, getRef } from './doc'
import { isPublished } from '../shared/post'
import { optionsResponse } from './utilities'

const compressResponse = compression()

const xmlUrl = (url: string) => `<url><loc>${url}</loc></url>`

export const sitemap = onRequest({}, async (req, res) => {
  if (optionsResponse(req, res)) {
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

  const postsRef = await getRef('post', true)
  if (postsRef instanceof Error) {
    res.status(500).send('Error loading posts')
    return
  }
  const postUrls: string[] = []
  const stream = (postsRef as FirebaseFirestore.Query).orderBy('date').stream()

  stream.on('error', (error) => {
    functions.logger.error('Sitemap stream error:', error)
    if (!res.headersSent) {
      res.status(500).send('Error generating sitemap')
    }
  })

  stream.on('data', (docSnap: FirebaseFirestore.QueryDocumentSnapshot) => {
    const post = docSnap.data()

    // Drafts must not reach the sitemap. Unpublished posts are deliberately
    // READABLE by direct link (so a draft can be shared for comment) — the
    // property that matters is that they are not findable by ACCIDENT, and
    // handing them to crawlers is the most direct way to break that.
    // `.orderBy('date')` does not filter them out: Firestore only skips
    // documents where the field is ABSENT, and `unpublish()` writes `''`.
    if (!isPublished(post)) return

    const date = new Date(post.date)
    if (isNaN(date.valueOf())) return // never emit /blog/NaN/NaN/NaN/...

    postUrls.push(
      // getMonth() is 0-based; the client's own linkFromRef adds 1, and these
      // URLs were off by a month against every link the site itself generates.
      `https://${host}/blog/${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}/${
        post.path
      }`
    )
  })

  stream.on('end', () => {
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
  })
})
