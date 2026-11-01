/**
 * /blob — storage areas over Cloud Storage (board #1136, step 2).
 *
 * Every decision and ordering lives in `blob-handler.ts` (tested against
 * in-memory fakes). This file only wires it to Firebase: the store port for the
 * metadata documents (committed through the same transactional write path as
 * /doc, so they carry `_by` and pass the area's schema), the Files port
 * (`files.ts`; Cloud Storage when deployed) for the bytes, the host's role resolution, and the shared error shape.
 */
import type { Handler } from './http'
import { log } from './log'
import { createHash } from 'crypto'
import { optionsResponse, getUserRoles, type AuthenticatedRequest } from './utilities'
import { fail, noStore } from './errors'
import { collectionsFor } from './install/installed'
import { hasPrivilegedRole } from './collections/access'
import { dataStore } from './datastore'
import { files } from './files'
import { commitTransactionally } from './commit'
import { handleBlob, type BlobDeps } from './blob-handler'
import type { BlobMeta } from './collections/blob'

const objects = files.objects

const deps: BlobDeps = {
  collectionsFor,
  getMeta: async (docPath) => {
    const doc = await dataStore.get(docPath)
    return doc.exists ? (doc.data as BlobMeta & Record<string, unknown>) : null
  },
  commitMeta: (docPath, meta, collections, userRoles, method) =>
    // An unnamed method is an upsert: create a file, or replace its metadata.
    commitTransactionally(
      [{ p: docPath, data: meta as unknown as Record<string, unknown>, ...(method ? { method } : {}) }],
      collections,
      userRoles
    ),
  deleteMeta: (docPath) => dataStore.delete(docPath),
  objects,
  sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
  isPrivileged: hasPrivilegedRole,
}

export const handleBlobEndpoint: Handler = async (request, response) => {
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
        objects.read(result.key).on('error', () => {
          // Before headers: a clean 404. After: end the response rather than
          // leave it hanging until the function times out.
          if (!response.headersSent) fail(response, 404, 'not-found', 'not found')
          else response.destroy()
        }).pipe(response)
        return
    }
  } catch (e) {
    log.error('blob failed', e)
    fail(response, 500, 'internal', 'blob operation failed')
  }
}
