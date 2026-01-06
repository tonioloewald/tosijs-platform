import { onRequest } from 'firebase-functions/v2/https'
import * as functions from 'firebase-functions'
import compression from 'compression'

import { getDoc, getRef } from './doc'
import { optionsResponse } from './utilities'

const compressResponse = compression()

const xmlUrl = (url: string) => `<url><loc>${url}</loc></url>`

export const sitemap = onRequest({}, async (req, res) => {
  if (optionsResponse(req, res)) {
    return
  }

  // Load app config to get host
  const appConfigResult = await getDoc(req, res, 'config/app')
  const host = appConfigResult.ok ? appConfigResult.data.host : req.hostname

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
    const date = new Date(post.date)
    postUrls.push(
      `https://${host}/blog/${date.getFullYear()}/${date.getMonth()}/${date.getDate()}/${
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
