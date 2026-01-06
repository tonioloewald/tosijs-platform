import { service } from './firebase'

declare global {
  interface Window {
    prefetched?: { [key: string]: any }
  }
}

let prefetchPromise: Promise<void> | null = null

// Fetch prefetch data from the endpoint if not already available
async function ensurePrefetched(): Promise<void> {
  if (window.prefetched) return

  if (!prefetchPromise) {
    prefetchPromise = (async () => {
      try {
        const url = window.location.pathname
        console.log(
          `%cfetching prefetch data for ${url}`,
          'background: orange; color: white'
        )
        const data = await service.prefetchData.get({ url })
        window.prefetched = data
        console.log(
          `%cprefetch data loaded`,
          'background: green; color: white',
          Object.keys(data)
        )
      } catch (e) {
        console.error('failed to fetch prefetch data', e)
        window.prefetched = {}
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
