import crypto from 'crypto'
import { onRequest } from 'firebase-functions/v2/https'
import { PUBLIC_ENDPOINT } from './endpoint-options'
import * as functions from 'firebase-functions'
import compression from 'compression'
import { optionsResponse } from './utilities'
import { asPublicRequest } from './public-request'
import { renderDocument } from './render/document'
import { serve } from './render/store'
import { siteOrigin } from './social-meta'

const compressResponse = compression()


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
  // SSR IS PUBLIC — enforced here, once, for every contributed handler.
  //
  // Prefetch output is shared and cached, so rendering it with the caller's
  // rights would let a privileged visitor bake their private view into the page
  // everyone else reads. blog.ts's handler builds its post pools with whatever
  // roles it is handed and writes them to config/blog-cache, which is publicly
  // readable, and author/owner hold `list: ALL` on post — so that was reachable.
  //
  // Doing it at the single invocation point rather than in each handler makes it
  // structural: under the route-contribution model a contributed handler should
  // not be ABLE to render privileged content, whoever wrote it.
  const publicReq = asPublicRequest(req)
  const prefetched = await Promise.all(
    prefetches.map((f) =>
      f(publicReq, res, url, options).catch((error) => {
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
  const merged = await getPrefetchData(req, res, url, options)
  // The shared, pure renderer (D23): it escapes the embedded data so a post
  // cannot end the <script> (a live XSS here until 2026-10-01), keeps keys
  // quoted (the old unquoting regex rewrote `"word":` inside strings), and
  // escapes the title as text.
  return renderDocument(
    {
      title: options.title,
      description: options.description,
      imageUrl: options.imageUrl,
      url: options.url || url,
      type: options.type,
    },
    merged,
    siteOrigin(req.headers ?? {})
  )
}

export const redirected = (url: string, req: any, res: any): boolean => {
  if (url.match(/^\/\d{4}\/\d{2}\/\d+\/[\w-]*$/)) {
    res.redirect(301, `/blog${url}`)
    return true
  }
  return false
}

export const prefetch = onRequest(PUBLIC_ENDPOINT, async (req, res) => {
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

  // Render on store (D23): serve stored artifacts, no queries. Behind a flag
  // until a live comparison against the old path matches for every route.
  if (process.env.RENDER_ON_STORE === 'true') {
    try {
      const served = await serve(url)
      const html = renderDocument(served.head, served.prefetched, siteOrigin(req.headers ?? {}))
      compressResponse(req, res, () => {
        res.header('Content-Type', 'text/html')
        res.header('Cache-Control', 'public, max-age=60, s-maxage=300')
        res.status(served.status).send(html)
      })
      return
    } catch (e) {
      // Never a broken page: fall back to the old path, and say so.
      functions.logger.error('render-on-store serve failed; falling back to the per-request path', e)
    }
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
export const prefetchData = onRequest(PUBLIC_ENDPOINT, async (req, res) => {
  if (optionsResponse(req, res)) {
    return
  }

  const url = (req.query.url as string) || '/'

  // The render-on-store path's data, for a live comparison with the old path.
  // Only while the switch is 'compare' or 'true': otherwise anonymous callers
  // could fill the store before anyone meant to use it (re-review).
  if (req.query.engine === 'store' && ['true', 'compare'].includes(process.env.RENDER_ON_STORE ?? '')) {
    const served = await serve(url)
    res.header('Content-Type', 'application/json')
    res.status(served.status).json(served.prefetched)
    return
  }

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
