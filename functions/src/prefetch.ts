import crypto from 'crypto'
import { onRequest } from 'firebase-functions/v2/https'
import * as functions from 'firebase-functions'
import compression from 'compression'
import { optionsResponse } from './utilities'
import { DOCTYPE, elements } from './elements'

const compressResponse = compression()

const iconUrl = '/logo.png'
const manifestUrl = '/manifest.json'
const scriptUrl = '/index.js'
const pageImage = '/logo.png'

export interface PageOptions {
  title: string
  description: string
  imageUrl: string
  url?: string
  type: string
}

export interface PrefetchData {
  [key: string]: any
}

export type PrefetchCallback = (
  req: any,
  res: any,
  url: string,
  options: PageOptions
) => Promise<PrefetchData>

const prefetches: PrefetchCallback[] = []

export function onPrefetch(callback: PrefetchCallback) {
  if (!prefetches.includes(callback)) {
    prefetches.push(callback)
  }
}

export const getPrefetchData = async (
  req: any,
  res: any,
  url: string,
  options: PageOptions
): Promise<PrefetchData> => {
  const prefetched = await Promise.all(
    prefetches.map((f) =>
      f(req, res, url, options).catch((error) => {
        functions.logger.warn('Prefetch handler failed:', error)
        return {}
      })
    )
  )
  return Object.assign({}, ...prefetched)
}

const render = async (
  req: any,
  res: any,
  nonce: string,
  url: string,
  options: PageOptions
): Promise<string> => {
  const { html, head, meta, title, link, script, body } = elements

  const merged = await getPrefetchData(req, res, url, options)
  const data = JSON.stringify(merged).replace(/"(\w+)":/g, '$1:')

  return (
    DOCTYPE +
    html(
      { lang: 'en' },
      head(
        meta({ charset: 'utf-8' }),
        title(options.title),
        meta({ name: 'description', content: options.description }),
        meta({ property: 'og:title', content: options.title }),
        meta({ property: 'og:description', content: options.description }),
        meta({ property: 'og:url', content: options.url || url }),
        meta({ property: 'og:image', content: options.imageUrl || pageImage }),
        meta({ property: 'og:type', content: options.type || 'website' }),
        link({ rel: 'icon', href: '/favicon.ico' }),
        meta({
          name: 'viewport',
          content: 'width=device-width, initial-scale=1',
        }),
        meta({ name: 'theme-color', content: '#000000' }),
        link({ rel: 'apple-touch-icon', href: options.imageUrl || iconUrl }),
        link({ rel: 'manifest', href: manifestUrl }),
        script(
          {
            /* nonce, */
          },
          `var prefetched = ${data}`
        ),
        script({ /* nonce, */ type: 'module', src: scriptUrl })
      ),
      body()
    )
  )
}

export const redirected = (url: string, req: any, res: any): boolean => {
  if (url.match(/^\/\d{4}\/\d{2}\/\d+\/[\w-]*$/)) {
    res.redirect(301, `/blog${url}`)
    return true
  }
  return false
}

export const prefetch = onRequest({}, async (req, res) => {
  if (optionsResponse(req, res)) {
    return
  }

  const url = (req.headers['x-forwarded-url'] ||
    req.headers['x-original-url']) as string

  if (redirected(url, req, res)) return

  if (url.match(/\.\w{3,4}$/)) {
    res.status(404).send()
    return
  }

  const nonce = crypto.randomBytes(16).toString('base64')
  const html = await render(req, res, nonce, url, {
    title: 'inconsequence',
    description: 'musings on subjects of passing interest',
    imageUrl: '',
    type: '',
  })

  compressResponse(req, res, () => {
    res.header('Content-Type', 'text/html')
    // TODO figure out how to implement dynamic nonces
    /*
    res.header(
      'Content-Security-Policy',
      `script-src 'nonce-${nonce}' 'self' www.googletagmanager.com apis.google.com`
    )
    */
    res.status(200).send(html)
  })
})

// Endpoint to get prefetch data as JSON (for dev https environment)
export const prefetchData = onRequest({}, async (req, res) => {
  if (optionsResponse(req, res)) {
    return
  }

  const url = (req.query.url as string) || '/'

  const options: PageOptions = {
    title: '',
    description: '',
    imageUrl: '',
    type: '',
  }

  const data = await getPrefetchData(req, res, url, options)

  compressResponse(req, res, () => {
    res.header('Content-Type', 'application/json')
    res.status(200).json(data)
  })
})
