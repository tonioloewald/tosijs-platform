/**
 * # /stored endpoint — the LEGACY file reader
 *
 * Serves files from the legacy folders of the default bucket (`blog/`,
 * `public/`, `users/` — LEGACY_FOLDERS in legacy-storage.ts) by redirecting to
 * a signed URL, or streaming when the host cannot sign.
 *
 * - GET /stored/blog/spaceship.webp → gs://<default bucket>/blog/spaceship.webp
 * - GET /stored/public/logo.png     → gs://<default bucket>/public/logo.png
 *
 * ## Access control — read before changing
 * This uses the ADMIN SDK, so storage.rules never applies to it. It shares the
 * bucket with /blob's storage areas, which have their own access rules and are
 * served only by /blob. So /stored reads ONLY the legacy folders — an
 * allowlist, never "everything but areas" (0.3.0 re-review 2). To add a
 * folder, change legacy-storage.ts AND storage.rules; a test checks they agree.
 *
 * ## Delivery
 * - Signed URLs expire after 1 hour; the redirect's Cache-Control matches.
 * - Without signing (emulator, or no signBlob permission) it streams, from the
 *   SITE's origin — so firebase.json sandboxes /stored/** (see SANDBOX_CSP).
 */

import { deliveryHeaders } from './blob-handler'
import { storedObjectPath } from './legacy-storage'
import { onRequest } from 'firebase-functions/v2/https'
import { PUBLIC_ENDPOINT } from './endpoint-options'
import * as admin from 'firebase-admin'

import { optionsResponse } from './utilities'
import { getMimeType } from '../shared/mime-types'

// Match the path after /stored/
const STORED_PATH_REGEX = /\/stored\/(.+)$/

// Signed URL expiration: 1 hour (in milliseconds)
const URL_EXPIRATION_MS = 60 * 60 * 1000

// Cache duration slightly less than URL expiration to ensure valid URLs
const CACHE_MAX_AGE_SECONDS = 55 * 60 // 55 minutes

export const stored = onRequest(PUBLIC_ENDPOINT, async (req, res) => {
  if (optionsResponse(req, res)) {
    return
  }

  const url = (req.headers['x-forwarded-url'] as string) || req.url
  if (!url?.split(/[?#]/)[0].match(STORED_PATH_REGEX)) {
    res.status(400).send('Invalid storage path')
    return
  }

  // ONLY the legacy folders (legacy-storage.ts). This reader uses the Admin
  // SDK, which storage.rules never applies to, and it shares the bucket with
  // /blob — so without an allowlist it would serve any storage area's private
  // objects to anyone with the key (0.3.0 re-review 2, B1). Refused exactly
  // like a missing file, so it reveals nothing.
  // (and never the query string — `?v=2` is not part of the object's name)
  const filePath = storedObjectPath(url)
  if (!filePath) {
    res.status(404).send('File not found')
    return
  }

  try {
    // The project's DEFAULT bucket — the one the client SDK uploads to and
    // /blob writes to. It was hardcoded as `<project>.appspot.com`, which is
    // wrong for newer projects (`.firebasestorage.app`).
    const bucket = admin.storage().bucket()
    const file = bucket.file(filePath)

    // Check if file exists
    const [exists] = await file.exists()
    if (!exists) {
      res.status(404).send('File not found')
      return
    }

    // Try to generate signed URL (works in production, fails in emulator)
    try {
      const [signedUrl] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + URL_EXPIRATION_MS,
      })

      // Set cache headers to match URL expiration
      res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE_SECONDS}`)
      res.set('Access-Control-Allow-Origin', '*')

      // Redirect to the signed URL
      res.redirect(302, signedUrl)
    } catch (signedUrlError) {
      // Fallback for emulator: stream the file directly
      const [metadata] = await file.getMetadata()
      // Use extension-based MIME type if metadata is missing or generic
      const contentType =
        metadata.contentType &&
        metadata.contentType !== 'application/octet-stream'
          ? metadata.contentType
          : getMimeType(filePath)

      res.set('Content-Type', contentType)
      res.set('Cache-Control', 'public, max-age=3600')
      res.set('Access-Control-Allow-Origin', '*')
      // Served from the SITE's origin (the /stored/** rewrite): never sniffed,
      // and anything but inert media is sandboxed — the same rule as /blob
      // (0.3.0 re-review: this was B1's twin; blog/ is writable by any
      // content role straight through the Storage SDK).
      res.set(deliveryHeaders(contentType))

      const stream = file.createReadStream()
      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).send('Error reading file')
        } else {
          res.destroy()
        }
      })
      stream.pipe(res)
    }
  } catch {
    res.status(500).send('Error fetching file')
  }
})
