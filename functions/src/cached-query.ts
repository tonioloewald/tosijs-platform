/*#
# /cachedQuery?url=...

Using the service proxy:

```
await fb.service.cachedQuery.get({url: 'https://itunes.apple.com/search?term=jack+johnson'})
```

This returns JSON from the url provided. Queries are cached for 24h. This both solves issues with content-security-policies and CORS and allows easy access to rate-limited services.
*/

import { onRequest } from 'firebase-functions/v2/https'
import compression from 'compression'
import crypto from 'crypto'
import {
  optionsResponse,
  getRecord,
  setRecord,
  timestamp,
  FirestoreDoc,
} from './utilities'

const CACHE_DURATION_MS = 24 * 3600 * 1000
const SIMPLE_URL_CHECK = /^https?:\/\/[^\s]+$/

interface CachedRecord extends FirestoreDoc {
  url: string
  data: unknown
  timestamp: string
}

export function simpleUrlHash(url: string, algorithm = 'sha1') {
  const hexHash = crypto.createHash(algorithm).update(url).digest('hex')

  const hashAsBigInt = BigInt(`0x${hexHash}`)

  return hashAsBigInt.toString(36)
}

const compressResponse = compression()

export const cachedQuery = onRequest({}, async (req, res) => {
  if (optionsResponse(req, res)) {
    return
  }

  const { query } = req

  const url = decodeURIComponent(String(query.url))

  if (!url || !SIMPLE_URL_CHECK.test(url)) {
    res
      .status(400)
      .json({ message: 'Invalid or missing URL parameter.', url: url || null })
    return
  }

  const docId = simpleUrlHash(url)
  const cached = await getRecord<CachedRecord>('cached-record', docId)
  if (
    cached?.timestamp &&
    Date.now() - new Date(cached.timestamp).valueOf() < CACHE_DURATION_MS
  ) {
    compressResponse(req, res, () => {
      res.json(cached.data)
    })
    return
  }

  let fetchResponse: Response
  try {
    fetchResponse = await fetch(url)
  } catch (error) {
    // 3. Network/DNS/Fetch Error
    // Use 503 (Service Unavailable) for issues reaching the external service
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown fetch error.'
    res
      .status(503)
      .json({ message: `Failed to connect to external URL: ${errorMessage}` })
    return
  }

  if (!fetchResponse.ok) {
    res.status(502).json({
      status: fetchResponse.status,
      message: 'the server did not respond successfully',
    })
    return
  }

  const doc: CachedRecord = { url, data: null, timestamp: '' }
  try {
    doc.data = await fetchResponse.json()
    doc.timestamp = timestamp()
    await setRecord<CachedRecord>('cached-record', doc, docId)
  } catch (e) {
    res.status(502).json({
      message:
        'Successfully fetched resource, but response body was not valid JSON.',
    })
    return
  }

  compressResponse(req, res, () => {
    res.json(doc.data)
  })
})
