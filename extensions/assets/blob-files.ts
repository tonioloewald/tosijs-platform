/**
 * `AssetFiles` for a host's storage areas: `/blob` for the bytes, `/docs` for
 * the listing (an area's listing is its metadata documents). No DOM; it needs
 * only `fetch`.
 *
 * Any other folder is refused: it is not a storage area, so this host has no
 * rules for it that `/blob` could apply.
 */
import { cleanPath, locate, type Asset, type AssetFiles } from './files.js'

export interface BlobFilesOptions {
  /** The host's endpoint base, ending in `/`: requests go to `<serviceUrl>blob` and `<serviceUrl>docs`. */
  serviceUrl: string
  /**
   * The caller's ID token, or nothing when signed out. Called with `true` to
   * ask for a fresh one: a host treats an expired token as no token, so a
   * refused write is retried once with a new one.
   */
  getToken?: (
    refresh: boolean
  ) => Promise<string | null | undefined> | string | null | undefined
  /** Where a page links a file: `<fileBase><area>/<path>`. Default `/blob/`, for a site whose hosting routes `/blob`. */
  fileBase?: string
  /** At most this many files are listed; past it the list is cut short, and says so. Default 2000. */
  maxListed?: number
  /** Default: the global `fetch`. */
  fetch?: typeof fetch
}

const failure = async (res: Response): Promise<string> => {
  const body = await res.json().catch(() => ({}))
  return body.message || body.error || `${res.status}`
}

const area = (path: string) => {
  const where = locate(path)
  if (!where.area)
    throw new Error(`${where.folder || path} is not a storage area`)
  return { area: where.area, name: where.name }
}

export function blobFiles(options: BlobFilesOptions): AssetFiles {
  const {
    serviceUrl,
    getToken,
    fileBase = '/blob/',
    maxListed = 2000,
  } = options
  const doFetch =
    options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

  const send = async (
    url: string,
    init: RequestInit = {}
  ): Promise<Response> => {
    const attempt = async (refresh: boolean) => {
      const token = await getToken?.(refresh)
      const headers = new Headers(init.headers)
      if (token) headers.set('Authorization', `Bearer ${token}`)
      return { token, res: await doFetch(url, { ...init, headers }) }
    }
    const first = await attempt(false)
    const mutating = init.method !== undefined && init.method !== 'GET'
    if (first.token && mutating && [401, 403, 404].includes(first.res.status)) {
      return (await attempt(true)).res
    }
    return first.res
  }

  return {
    async list(folder) {
      const where = area(folder)
      const query = new URLSearchParams({
        p: where.area,
        c: String(maxListed),
        f: 'path,contentType',
      })
      const res = await send(`${serviceUrl}docs?${query}`)
      if (!res.ok)
        throw new Error(`could not list ${where.area}: ${await failure(res)}`)
      const docs = (await res.json()) as Array<{
        path: string
        contentType?: string
      }>
      if (!Array.isArray(docs)) throw new Error(`could not list ${where.area}`)
      if (docs.length >= maxListed) {
        console.warn(
          `${where.area}: more than ${maxListed} files; the list is cut short`
        )
      }
      return docs
        .map(
          (doc): Asset => ({
            name: doc.path,
            path: `${where.area}/${doc.path}`,
            contentType: doc.contentType,
          })
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    async upload(body, path) {
      const where = area(path)
      // /blob only takes clean names, so the name is cleaned here rather than
      // refused there; the path returned is the one the file actually has.
      const cleaned = cleanPath(where.name)
      const res = await send(`${serviceUrl}blob/${where.area}/${cleaned}`, {
        method: 'PUT',
        headers: { 'Content-Type': body.type || 'application/octet-stream' },
        body,
      })
      if (!res.ok) throw new Error(await failure(res))
      return `${where.area}/${cleaned}`
    },

    async remove(path) {
      const where = area(path)
      return (
        await send(`${serviceUrl}blob/${where.area}/${where.name}`, {
          method: 'DELETE',
        })
      ).ok
    },

    async move(from, to) {
      // A move on the server: nothing is downloaded.
      const a = locate(from)
      const b = locate(to)
      if (!a.area || !b.area) return false
      const res = await send(`${serviceUrl}blob`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 'move',
          from: { area: a.area, path: a.name },
          to: { area: b.area, path: cleanPath(b.name) },
        }),
      })
      if (!res.ok) console.error(`could not move ${from}:`, await failure(res))
      return res.ok
    },

    url(path) {
      const where = area(path)
      return `${fileBase}${where.area}/${where.name}`
    },
  }
}
