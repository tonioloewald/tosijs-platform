import { onRequest } from 'firebase-functions/v2/https'
import compression from 'compression'

import { optionsResponse, getUserRoles } from './utilities'

const compressResponse = compression()

export const user = onRequest({}, async (req, res) => {
  if (optionsResponse(req, res)) {
    return
  }
  const userRoles = await getUserRoles(req)
  compressResponse(req, res, () => {
    res.json(userRoles)
  })
})
