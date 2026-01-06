/**
 * # /stored endpoint
 *
 * Redirects to signed URLs for files in Firebase Cloud Storage.
 *
 * ## Usage
 * - GET /stored/blog/spaceship.webp - redirects to signed URL for gs://bucket/blog/spaceship.webp
 * - GET /stored/images/photo.jpg - redirects to signed URL for gs://bucket/images/photo.jpg
 *
 * This allows embedding storage files directly in HTML without needing
 * to use the storage API to get signed URLs.
 *
 * ## Caching Strategy
 * - Signed URLs expire after 1 hour
 * - Response includes Cache-Control header matching the URL expiration
 * - Browsers/CDNs cache the redirect, avoiding repeated function calls
 *
 * ## Emulator Support
 * - The Storage emulator doesn't support getSignedUrl()
 * - Falls back to streaming the file directly when signed URL fails
 *
 * ## Access Control
 * Files are served based on storage.rules - currently all files are publicly readable.
 */

import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'

import { optionsResponse } from './utilities'
import { getMimeType } from '../shared/mime-types'

// Match the path after /stored/
const STORED_PATH_REGEX = /\/stored\/(.+)$/

// Signed URL expiration: 1 hour (in milliseconds)
const URL_EXPIRATION_MS = 60 * 60 * 1000

// Cache duration slightly less than URL expiration to ensure valid URLs
const CACHE_MAX_AGE_SECONDS = 55 * 60 // 55 minutes

export const stored = onRequest({}, async (req, res) => {
  if (optionsResponse(req, res)) {
    return
  }

  const url = (req.headers['x-forwarded-url'] as string) || req.url
  const match = url?.match(STORED_PATH_REGEX)

  if (!match) {
    res.status(400).send('Invalid storage path')
    return
  }

  const filePath = match[1]

  // Sanitize path: prevent directory traversal
  if (filePath.includes('..') || filePath.startsWith('/')) {
    res.status(400).send('Invalid storage path')
    return
  }

  try {
    // Get the default bucket name from Firebase config
    const projectId =
      process.env.GCLOUD_PROJECT ||
      (process.env.FIREBASE_CONFIG &&
        JSON.parse(process.env.FIREBASE_CONFIG).projectId)
    const bucketName = `${projectId}.appspot.com`
    const bucket = admin.storage().bucket(bucketName)
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

      const stream = file.createReadStream()
      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).send('Error reading file')
        }
      })
      stream.pipe(res)
    }
  } catch {
    res.status(500).send('Error fetching file')
  }
})
