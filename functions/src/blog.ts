import { log } from './log'
import { PLATFORM_HOOKS } from './collections/hooks'
import { getDocs } from './docs'
import { getDoc } from './doc'
import { config } from './config'
import { getRecord, setRecord, AuthenticatedRequest } from './utilities'
import { Response } from 'express'

import { onPrefetch, PageOptions, PrefetchData } from './prefetch'
import { resolvePage } from './page'
import { POST_COLLECTION } from '../shared/post'
import { firstImage } from './social-meta'
import { namesBeyondPage, notFoundPath } from './render/site'

interface BlogConfig {
  prefix: string
  cacheDuration: number
}

interface BlogCache {
  _id?: string
  _collection?: string
  _created?: string
  _modified?: string
  _deleted?: boolean
  cleared?: string
  timestamp: string
  latestPosts: Record<string, unknown>[]
  recentPosts: Record<string, unknown>[]
}

const DEFAULT_CACHE_DURATION_MS = 24 * 60 * 60 * 1000 // 24 hours

let blogConfig: BlogConfig | undefined

// Clear the blog cache (called when posts are saved)
export async function clearBlogCache(): Promise<void> {
  try {
    const clearRecord: Partial<BlogCache> = {
      cleared: new Date().toISOString(),
    }
    await setRecord('config', clearRecord as BlogCache, 'blog-cache')
  } catch (e) {
    // Cache clear failed - cache will expire naturally; log for debugging
    log.warn('Failed to clear blog cache:', e)
  }
}

onPrefetch(
  async (
    req: AuthenticatedRequest,
    res: Response,
    url: string,
    options: PageOptions
  ): Promise<PrefetchData> => {
    // Only prefetch blog data if on the blog page or configured to always prefetch
    const { page } = await resolvePage(req, res, url)
    const isOnBlogPage = page?.path === 'blog'
    if (!config.alwaysPrefetchBlog && !isOnBlogPage) {
      return {}
    }

    // Load blog config if not already loaded
    if (!blogConfig) {
      const blogConfigResult = await getDoc(req, res, 'config/blog')
      blogConfig = blogConfigResult.ok
        ? (blogConfigResult.data as BlogConfig)
        : { prefix: '', cacheDuration: DEFAULT_CACHE_DURATION_MS }
    }

    const cacheDuration = blogConfig.cacheDuration || DEFAULT_CACHE_DURATION_MS

    // Try to load cache from Firestore
    let blogCache = (await getRecord('config', 'blog-cache')) as
      | BlogCache
      | undefined
    const cacheTimestamp = blogCache?.timestamp
      ? new Date(blogCache.timestamp).valueOf()
      : 0
    const cacheExpired =
      !blogCache ||
      !blogCache.latestPosts?.length ||
      cacheTimestamp + cacheDuration < Date.now()

    if (cacheExpired) {
      const [latestPosts, recentPosts] = await Promise.all([
        getDocs(req, res, POST_COLLECTION, 6, false, 'date(desc)'),
        getDocs(
          req,
          res,
          POST_COLLECTION,
          30,
          ['title', 'date', 'summary', 'keywords', 'path'],
          'date(desc)'
        ),
      ])

      blogCache = {
        timestamp: new Date().toISOString(),
        recentPosts,
        latestPosts,
      }

      // Save cache to Firestore
      await setRecord('config', blogCache, 'blog-cache')
    }

    // At this point blogCache is guaranteed to be defined (either loaded or just created)
    const {
      timestamp: blogDataTimestamp,
      recentPosts,
      latestPosts,
    } = blogCache as BlogCache
    const [, postPath] = url.match(/\/([\w-]+)\/?$/) || []
    let currentPost = !postPath
      ? latestPosts[0]
      : latestPosts.find((post: any) => post.path === postPath)

    if (!currentPost && postPath) {
      const postResult = await getDoc(req, res, `${POST_COLLECTION}/path=${postPath}`)
      currentPost = postResult.ok ? postResult.data : undefined
    }

    // Only override page metadata with blog post metadata if we're on the blog page
    // and either have a current post or defaultToBlogMetadata is enabled
    if (isOnBlogPage && (currentPost || config.defaultToBlogMetadata)) {
      const post = currentPost || latestPosts[0]
      const title = post.title as string | undefined
      const imageUrl = post.imageUrl as string | undefined
      const summary = post.summary as string | undefined
      const path = post.path as string | undefined
      const content = post.content as string | undefined
      // blogConfig is guaranteed to be defined at this point (loaded at start of function)
      options.title = (blogConfig as BlogConfig).prefix + (title || '')
      options.imageUrl = imageUrl || firstImage(content) || options.imageUrl
      options.description = summary || options.description
      options.url = `/blog/${path}`
      options.type = 'article'
    }

    const pageData: { [key: string]: any } = {
      latestPosts: latestPosts.map((post: any) => post.path),
      recentPosts,
      blogDataTimestamp,
      blogVersion: 4,
    }
    for (const post of latestPosts) {
      pageData[`${POST_COLLECTION}/path=${post.path}`] = post
    }
    if (currentPost) {
      pageData[`${POST_COLLECTION}/path=${currentPost.path}`] = currentPost
    } else if (isOnBlogPage && namesBeyondPage(url)) {
      // `/blog/<slug>` with no such post: a 404 showing the blog (#3913).
      pageData.notFound = notFoundPath(url)
    }

    return pageData
  }
)

async function clearBlogCacheAfterWrite(): Promise<void> {
  await clearBlogCache()
}

// The blog's posts are installed by the blog manifest (D28), so their rules
// are data and carry no code. A cache clear is not authority, so it attaches
// by name (collections/hooks.ts).
PLATFORM_HOOKS[POST_COLLECTION] = { afterWrite: clearBlogCacheAfterWrite }
