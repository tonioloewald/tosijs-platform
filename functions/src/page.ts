import { COLLECTIONS } from './collections'
import { ALL } from './collections/access'
import { ROLES } from './collections/roles'
import { getDoc } from './doc'
import { getDocs } from './docs'

import { onPrefetch, PageOptions, PrefetchData } from './prefetch'
import { Page, PageSchema } from '../shared/page'

// Exported so other prefetch handlers can check the current page
/**
 * The page (and app config) a prefetch request resolves to — computed ONCE per
 * request and shared by every handler. It used to be a module global set by
 * this handler and read by blog.ts's, but the handlers run CONCURRENTLY, so
 * blog.ts read it before it was set; it only worked when a warm instance still
 * held the previous request's page. A fresh deploy rendered every post with
 * the site's generic title. Keyed by the request object, which
 * getPrefetchData passes identically to every handler.
 */
const resolved = new WeakMap<object, Promise<{ appConfig?: AppConfig; page?: Page }>>()
export function resolvePage(req: any, res: any, url: string) {
  let p = resolved.get(req)
  if (!p) {
    p = (async () => {
      const [_path] = url.substring(1).split('?', 2)
      const [urlPath] = _path.split('/')

      // Load app config
      const appConfigResult = await getDoc(req, res, 'config/app')
      const appConfig = appConfigResult.ok
        ? (appConfigResult.data as AppConfig)
        : undefined

      // Determine which path to load (use defaultPath if at root and it's set)
      const path =
        !urlPath && appConfig?.defaultPath ? appConfig.defaultPath : urlPath

      // Load page by path
      const pageResult = await getDoc(req, res, `page/path=${path}`)
      let page = pageResult.ok ? (pageResult.data as Page) : undefined

      // If no page found, load the 404 page
      if (!page) {
        const notFoundResult = await getDoc(req, res, `page/path=404`)
        page = notFoundResult.ok ? (notFoundResult.data as Page) : undefined
      }
      return { appConfig, page }
    })()
    resolved.set(req, p)
  }
  return p
}

interface AppConfig {
  title: string
  subtitle?: string
  description: string
  defaultPath?: string
}

onPrefetch(
  async (
    req: any,
    res: any,
    url: string,
    options: PageOptions
  ): Promise<PrefetchData> => {
    const data: PrefetchData = {}
    const { appConfig, page } = await resolvePage(req, res, url)
    data.appConfig = appConfig

    // Get visible pages for navigation menu
    const visiblePages = await getDocs(req, res, 'page/tags=visible', 100)
    data.visiblePages = visiblePages.sort((a: any, b: any) => {
      const aSort = a.navSort ?? a.title.toLowerCase()
      const bSort = b.navSort ?? b.title.toLowerCase()
      return aSort.localeCompare(bSort)
    })

    if (page) {
      data.page = page

      if (page.title) {
        options.title = page.title
      }
      if (page.description) {
        options.description = page.description
      }
      if (page.imageUrl) {
        options.imageUrl = page.imageUrl
      }
      if (page.type) {
        options.type = page.type
      }
      if (page.prefetch?.length) {
        await Promise.all(
          page.prefetch.map(async ({ regexp, path: prefetchPath }) => {
            const parts: string[] = regexp
              ? url.match(new RegExp(regexp)) || []
              : []
            try {
              const hydratedPath = prefetchPath.replace(
                /\[(\d+)\]/g,
                (_, index) => {
                  const part = parts[Number(index)]
                  if (part === undefined) {
                    throw new Error('path could not be hydrated')
                  }
                  return part
                }
              )

              const prefetchResult = await getDoc(req, res, hydratedPath)
              data[hydratedPath] = prefetchResult.ok
                ? prefetchResult.data
                : undefined
            } catch {
              // Prefetch failed - page will still render, just without this data
            }
          })
        )
      }
    }
    return data
  }
)

COLLECTIONS.page = {
  schema: PageSchema,
  unique: ['path'],
  tagFields: ['tags'],
  access: {
    [ROLES.public]: {
      read: async (page) => {
        return page.tags.includes('public') ? page : new Error('not visible')
      },
      list: async (page) => {
        return page.tags.includes('public') && page.tags.includes('visible')
          ? page
          : new Error('not public and visible')
      },
    },
    [ROLES.admin]: {
      read: ALL,
      write: ALL,
      list: ALL,
    },
  },
}
