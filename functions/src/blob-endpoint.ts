/**
 * /blob — storage areas over Cloud Storage (board #1136, step 2).
 *
 * Every decision and ordering lives in `blob-handler.ts` (tested against
 * in-memory fakes). This file only wires it to Firebase: Firestore for the
 * metadata documents (committed through the same transactional write path as
 * /doc, so they carry `_by` and pass the area's schema), Cloud Storage for the
 * bytes, the host's role resolution, and the shared error shape.
 */
import { onRequest } from 'firebase-functions/v2/https'
import { PUBLIC_ENDPOINT } from './endpoint-options'
import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import { createHash } from 'crypto'
import { optionsResponse, getUserRoles, type AuthenticatedRequest } from './utilities'
import { fail, noStore } from './errors'
import { collectionsFor } from './install/installed'
import { hasPrivilegedRole } from './collections/access'
import { physicalPath } from './collections/namespace'
import { commitTransactionally } from './commit'
import { handleBlob, type BlobDeps } from './blob-handler'
import type { BlobMeta } from './collections/blob'

const bucket = () => admin.storage().bucket()
let signingWarned = false

const deps: BlobDeps = {
  collectionsFor,
  getMeta: async (docPath) => {
    const snap = await admin.firestore().doc(physicalPath(docPath)).get()
    return snap.exists ? (snap.data() as BlobMeta & Record<string, unknown>) : null
  },
  commitMeta: (docPath, meta, collections, userRoles, method) =>
    // An unnamed method is an upsert: create a file, or replace its metadata.
    commitTransactionally(
      [{ p: docPath, data: meta as unknown as Record<string, unknown>, ...(method ? { method } : {}) }],
      collections,
      userRoles
    ),
  deleteMeta: async (docPath) => {
    await admin.firestore().doc(physicalPath(docPath)).delete()
  },
  objects: {
    put: async (key, bytes, contentType) => {
      await bucket().file(key).save(Buffer.from(bytes), { contentType, resumable: false })
    },
    delete: async (key) => {
      await bucket().file(key).delete({ ignoreNotFound: true })
    },
    copy: async (from, to) => {
      await bucket().file(from).copy(bucket().file(to))
    },
    head: async (key) => {
      const file = bucket().file(key)
      const [exists] = await file.exists()
      if (!exists) return null
      const [meta] = await file.getMetadata()
      return { bytes: Number(meta.size ?? 0), contentType: String(meta.contentType ?? 'application/octet-stream') }
    },
    hash: (key) =>
      new Promise<string>((resolve, reject) => {
        const h = createHash('sha256')
        bucket()
          .file(key)
          .createReadStream()
          .on('error', reject)
          .on('data', (chunk) => h.update(chunk))
          .on('end', () => resolve(h.digest('hex')))
      }),
    url: async (key, ttlSeconds, contentType) => {
      try {
        const [url] = await bucket()
          .file(key)
          .getSignedUrl({ action: 'read', expires: Date.now() + ttlSeconds * 1000, responseType: contentType })
        return url
      } catch (e) {
        // No signing here — the emulator, or a service account without
        // iam.serviceAccounts.signBlob ("Service Account Token Creator" on
        // itself). The handler then STREAMS the bytes, which is correct (same
        // access check, same cache policy), just proxied through the function.
        // Logged once per instance, never silent (0.2.x ceremony finding).
        if (!signingWarned) {
          signingWarned = true
          functions.logger.warn(
            'blob: cannot sign URLs — streaming files through the function instead. ' +
              'Grant the functions service account "Service Account Token Creator" on itself to enable redirects.',
            e
          )
        }
        return null
      }
    },
  },
  sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
  isPrivileged: hasPrivilegedRole,
}

export const blob = onRequest(PUBLIC_ENDPOINT, async (request, response) => {
  const req = request as AuthenticatedRequest
  noStore(response)
  if (optionsResponse(req, response, ['OPTIONS', 'GET', 'PUT', 'DELETE', 'POST'])) return

  try {
    const userRoles = await getUserRoles(req)
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody
    const result = await handleBlob(
      {
        method: req.method,
        pathname: req.path,
        contentType: req.get('content-type') ?? undefined,
        body: req.method === 'PUT' && raw ? new Uint8Array(raw) : undefined,
        json: req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : undefined,
        userRoles,
      },
      deps
    )

    switch (result.kind) {
      case 'json':
        response.status(result.status).json(result.body)
        return
      case 'error':
        fail(response, result.status, result.error as never, result.message, result.extra ?? {})
        return
      case 'redirect':
        response.set('Cache-Control', result.cacheControl)
        response.redirect(302, result.url)
        return
      case 'stream':
        response.set('Cache-Control', result.cacheControl)
        response.set('Content-Type', result.contentType)
        response.set(result.headers)
        bucket().file(result.key).createReadStream().on('error', () => {
          // Before headers: a clean 404. After: end the response rather than
          // leave it hanging until the function times out.
          if (!response.headersSent) fail(response, 404, 'not-found', 'not found')
          else response.destroy()
        }).pipe(response)
        return
    }
  } catch (e) {
    functions.logger.error('blob failed', e)
    fail(response, 500, 'internal', 'blob operation failed')
  }
})
