import * as functions from 'firebase-functions'
import { COLLECTIONS } from './collections'
import { ALL } from './collections/access'
import { ROLES } from './collections/roles'
import { getDocs } from './docs'
import { getDoc } from './doc'
import { config } from './config'
import { getRecord, setRecord, AuthenticatedRequest } from './utilities'
import { Response } from 'express'

import { onPrefetch, PageOptions, PrefetchData } from './prefetch'
import { currentPage } from './page'
import { PostSchema } from '../shared/post'

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
    functions.logger.warn('Failed to clear blog cache:', e)
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
    const isOnBlogPage = currentPage?.path === 'blog'
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
        getDocs(req, res, 'post', 6, false, 'date(desc)'),
        getDocs(
          req,
          res,
          'post',
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
      const postResult = await getDoc(req, res, `post/path=${postPath}`)
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
      options.imageUrl =
        imageUrl ||
        content?.match(/<img[^>]+src="([^"]+)"/)?.[1] ||
        options.imageUrl
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
      pageData[`post/path=${post.path}`] = post
    }
    if (currentPost) {
      pageData[`post/path=${currentPost.path}`] = currentPost
    }

    return pageData
  }
)

COLLECTIONS.post = {
  schema: PostSchema,
  unique: ['title', 'path'],
  async validate(data: any): Promise<Error | any> {
    // Auto-generate path from title if not provided
    if (!data.path) {
      data.path = data.title.toLocaleLowerCase().replace(/[^\w]+/g, '-')
    }

    // Clear the blog cache so changes are visible immediately
    await clearBlogCache()

    return data
  },
  access: {
    [ROLES.public]: {
      read: ALL,
      list: (data: any) =>
        data.date !== undefined ? data : new Error('unpublished'),
    },
    [ROLES.author]: {
      write: ALL,
      list: ALL,
    },
  },
}
