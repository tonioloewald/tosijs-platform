import { onRequest } from 'firebase-functions/v2/https'
import compression from 'compression'

import { optionsResponse, getUser, getUserRoles, timestamp } from './utilities'

const compressResponse = compression()

export const hello = onRequest({}, async (req, res) => {
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
