/**
 * # /esm endpoint
 *
 * Serves ES modules from the `module` collection as JavaScript.
 *
 * ## Usage
 * - GET /esm/foo - returns module named "foo" as text/javascript
 * - GET /esm/foo.js - same as above (extension stripped)
 * - GET /esm/foo.jsx - same as above
 * - GET /esm/foo.mjs - same as above
 *
 * ## Access Control
 * Access rules are defined in module.ts collection config:
 * - Public users can only read modules tagged with 'public'
 * - Developers have full access
 *
 * ## TODO
 * - [ ] Support versioned responses (e.g., /esm/foo@1.0.0 or /esm/foo@^1.0.0)
 *       via a document subcollection
 * - [ ] Support versioned tests as a subcollection
 *       (run most recent test whose version does not exceed module version)
 */

import { onRequest } from 'firebase-functions/v2/https'
import compression from 'compression'

import { optionsResponse } from './utilities'
import { getDoc } from './doc'
import type { Module } from '../shared/module'

const compressResponse = compression()

// Match module name, stripping optional .js/.jsx/.mjs extension
const MODULE_PATH_REGEX = /\/esm\/([^/]+?)(?:\.m?jsx?)?\/?$/

export const esm = onRequest({}, async (req, res) => {
  if (optionsResponse(req, res)) {
    return
  }

  const url = (req.headers['x-forwarded-url'] as string) || req.url
  const match = url?.match(MODULE_PATH_REGEX)

  if (!match) {
    res.status(400).send('Invalid module path')
    return
  }

  const name = match[1]

  const result = await getDoc(req, res, `module/name=${name}`)

  if (!result.ok) {
    res.status(result.status).send(result.reason)
    return
  }

  const mod = result.data as Module

  compressResponse(req, res, () => {
    res.type('text/javascript')
    res.send(mod.source)
  })
})
