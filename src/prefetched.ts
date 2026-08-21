import { service } from './firebase'

declare global {
  interface Window {
    prefetched?: { [key: string]: any }
  }
}

let prefetchPromise: Promise<void> | null = null

// The SSR shell injects `window.prefetched` as an optimization, but that
// injected payload can be partial (in production it arrives with only the blog
// keys, missing the app-shell keys — appConfig/page/visiblePages — that the
// page renderer needs, which left the home page stuck on "Loading"). Treat a
// payload lacking `appConfig` as incomplete and fetch the authoritative set
// from the endpoint, merging so any injected data still seeds. Locally there is
// no injected payload, so this fetch always ran — which is why localhost worked.
const isComplete = (data: unknown): boolean =>
  !!data && typeof data === 'object' && 'appConfig' in (data as object)

// Fetch prefetch data from the endpoint if not already available
async function ensurePrefetched(): Promise<void> {
  if (isComplete(window.prefetched)) return

  if (!prefetchPromise) {
    prefetchPromise = (async () => {
      try {
        const url = window.location.pathname
        console.log(
          `%cfetching prefetch data for ${url}`,
          'background: orange; color: white'
        )
        const data = await service.prefetchData.get({ url })
        if (data && !(data instanceof Error)) {
          // merge over any partial SSR-injected payload
          window.prefetched = { ...(window.prefetched || {}), ...data }
          console.log(
            `%cprefetch data loaded`,
            'background: green; color: white',
            Object.keys(data)
          )
        } else {
          console.error('prefetch data request failed', data)
          window.prefetched = window.prefetched || {}
        }
      } catch (e) {
        console.error('failed to fetch prefetch data', e)
        window.prefetched = window.prefetched || {}
      }
    })()
  }

  return prefetchPromise
}

export async function getPrefetchedDoc(
  path: string,
  fetchIfNeeded = true
): Promise<any> {
  await ensurePrefetched()

  if (window.prefetched && Object.keys(window.prefetched).includes(path)) {
    console.log(`${path} %cprefetched`, 'background: green; color: white')
    return window.prefetched[path]
  } else if (fetchIfNeeded) {
    console.log(
      `${path} %cnot prefetched, fetching...`,
      'background: purple; color: white'
    )
    return service.doc.get({ p: path })
  } else {
    console.log(`${path} %cnot prefetched`, 'background: purple; color: white')
    return undefined
  }
}

// Get a specific key from prefetched data
export async function getPrefetched<T = any>(
  key: string
): Promise<T | undefined> {
  await ensurePrefetched()
  return window.prefetched?.[key] as T | undefined
}

// Ensure prefetch data is loaded (call early in app initialization)
export { ensurePrefetched }
