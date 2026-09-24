import { onRequest } from 'firebase-functions/v2/https'
import compression from 'compression'

import { optionsResponse, getUserRoles } from './utilities'
import { noStore } from './errors'

const compressResponse = compression()

export const user = onRequest({}, async (req, res) => {
  // A platform API response is about the caller who asked — never shared
  // by a CDN (#27). Set FIRST, so it also covers an uncaught throw and the
  // rate-limit / method refusals inside optionsResponse. A handler that is
  // genuinely public may override it.
  noStore(res)
  if (optionsResponse(req, res)) {
    return
  }
  const userRoles = await getUserRoles(req)
  compressResponse(req, res, () => {
    res.json(userRoles)
  })
})
