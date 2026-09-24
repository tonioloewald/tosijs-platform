import { onRequest } from 'firebase-functions/v2/https'
import compression from 'compression'

import { optionsResponse, getUser, getUserRoles, timestamp } from './utilities'
import { noStore } from './errors'

const compressResponse = compression()

export const hello = onRequest({}, async (req, res) => {
  // A platform API response is about the caller who asked — never shared
  // by a CDN (#27). Set FIRST, so it also covers an uncaught throw and the
  // rate-limit / method refusals inside optionsResponse. A handler that is
  // genuinely public may override it.
  noStore(res)
  if (optionsResponse(req, res)) {
    return
  }
  const user = await getUser(req)
  const userRoles = await getUserRoles(req)

  const { query, headers } = req

  compressResponse(req, res, () => {
    res.json({
      result: `hello ${query.name || 'to you'} too!`,
      timestamp: timestamp(),
      user,
      userRoles,
      req: { query, headers },
      version: 2,
    })
  })
})
