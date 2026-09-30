/**
 * The /blob request handler (board #1136, step 2) — every decision and every
 * ordering, with the store, the metadata and the clock INJECTED, so it is
 * tested against in-memory fakes. `blob-endpoint.ts` wires it to Firebase.
 *
 * ## Routes
 *
 *   GET    /blob/<area>/<path>   → 302 to the file (public: stable, cacheable;
 *                                  private: a short-lived signed link after the
 *                                  access check)
 *   PUT    /blob/<area>/<path>   → store the request body (Content-Type header)
 *   DELETE /blob/<area>/<path>   → delete the file and its metadata
 *   POST   /blob  {op: "move", from: {area, path}, to: {area, path}}
 *
 * ## Consistency: object keys carry the content hash
 *
 * The bytes live at `objectKey(area, path, sha256)`. A replace writes NEW
 * bytes under a NEW key, commits the metadata, and only then deletes the old
 * object; a failure before the commit deletes the new object. So metadata
 * never points at the wrong bytes, and "a metadata document exists" always
 * means "its file exists". The worst a crash can leave is an orphaned object —
 * cost, never corruption.
 */
import {
  blobDocId,
  decideDelete,
  decideMove,
  decidePut,
  decideRead,
  isBlobStore,
  isSingleMediaType,
  validateBlobPath,
  type BlobMeta,
  type BlobRefusal,
} from './collections/blob'
import type { CollectionMap } from './collections/access'
import type { UserRoles } from './collections/roles'
import type { CommitOutcome } from './commit'

/** Largest body the endpoint accepts at all, whatever an area allows. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export const objectKey = (area: string, path: string, sha256: string): string =>
  `${area}/${path}@${sha256.slice(0, 16)}`

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  delete(key: string): Promise<void>
  copy(from: string, to: string): Promise<void>
  /** A URL for the object, or null when this substrate cannot sign (emulator). */
  url(key: string, ttlSeconds: number): Promise<string | null>
}

export interface BlobDeps {
  collectionsFor(area: string): Promise<CollectionMap>
  getMeta(docPath: string): Promise<(BlobMeta & Record<string, unknown>) | null>
  /** Commit a metadata document through the write pipeline (provenance, schema). */
  commitMeta(
    docPath: string,
    meta: BlobMeta,
    collections: CollectionMap,
    userRoles: UserRoles,
    /** 'POST' = must not exist yet (a move); omitted = upsert (an upload). */
    method?: 'POST'
  ): Promise<CommitOutcome>
  deleteMeta(docPath: string): Promise<void>
  objects: ObjectStore
  sha256(bytes: Uint8Array): string
  isPrivileged(userRoles: UserRoles): boolean
}

export type BlobResponse =
  | { kind: 'json'; status: number; body: Record<string, unknown> }
  | { kind: 'error'; status: number; error: string; message: string; extra?: Record<string, unknown> }
  | { kind: 'redirect'; url: string; cacheControl: string }
  | { kind: 'stream'; key: string; contentType: string; cacheControl: string; headers: Record<string, string> }

/**
 * Headers for bytes served FROM THIS ORIGIN (the stream fallback, and /blob is
 * rewritten onto the site's own domain). A redirect lands on the storage host,
 * a different origin; a stream does not — so an uploaded SVG or anything a
 * browser might read as HTML would run script as the site.
 *
 * Never sniff, and SANDBOX BY DEFAULT: only an allowlist of inert media (one
 * exact type each — see isSingleMediaType) is served without the sandbox CSP.
 * A denylist of scriptable types was bypassed by a comma-joined type, and
 * misses `+xml` and whatever comes next (0.3.0 review B1).
 */
const INERT = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/pdf|text\/plain|application\/json)$/
export function deliveryHeaders(contentType: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-Content-Type-Options': 'nosniff' }
  const type = contentType.split(';')[0].trim().toLowerCase()
  if (!isSingleMediaType(contentType) || !INERT.test(type) || /\+xml$/.test(type)) {
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
  }
  return headers
}

/**
 * Public files. A REDIRECT names a hash-specific object that a replace or move
 * deletes as soon as it commits, so it must not be cached: a cached 302 would
 * point readers at a deleted object for its whole max-age (0.3.0 review M2).
 * STREAMED bytes are the file itself, so they may be cached briefly — a reader
 * sees the old file for at most this long after a replace, never a broken one.
 */
const PUBLIC_REDIRECT_CACHE = 'no-cache'
const PUBLIC_STREAM_CACHE = 'public, max-age=300'
const PUBLIC_SIGN_TTL = 3600
/** Private files: never cached by anyone but the requester, and briefly. */
const PRIVATE_CACHE = 'private, no-store'

const metaPath = (area: string, path: string) => `${area}/${blobDocId(path)}`

/** A refusal from blob.ts, as a response — `forbidden` stays OPAQUE for non-privileged callers. */
function refused(r: BlobRefusal, deps: BlobDeps, userRoles: UserRoles): BlobResponse {
  switch (r.reason) {
    case 'forbidden':
      return deps.isPrivileged(userRoles)
        ? { kind: 'error', status: 403, error: 'forbidden', message: 'forbidden' }
        : { kind: 'error', status: 404, error: 'not-found', message: 'not found' }
    case 'too-large':
      return { kind: 'error', status: 413, error: 'too-large', message: r.message }
    case 'type':
      return { kind: 'error', status: 415, error: 'unsupported-type', message: r.message }
    default:
      return { kind: 'error', status: 400, error: 'bad-request', message: r.message }
  }
}

/**
 * Roll back an object this request wrote — unless the committed metadata
 * references it. Keys are content-addressed, so the same bytes re-PUT with a
 * new type, or two concurrent PUTs of the same bytes, write the key that is
 * ALREADY live; deleting it blindly left metadata with no file (0.3.0 review M1).
 */
async function releaseIfUnreferenced(deps: BlobDeps, docPath: string, key: string, sha256: string) {
  const current = await deps.getMeta(docPath).catch(() => undefined)
  if (current === undefined || current?.sha256 === sha256) return // unknown or live: keep it
  await deps.objects.delete(key).catch(() => undefined)
}

const commitStatus = (reason: string): number =>
  reason === 'immutable' ? 409 : reason === 'schema' ? 400 : 403

const notFound: BlobResponse = { kind: 'error', status: 404, error: 'not-found', message: 'not found' }

/**
 * Split `/<area>/<path…>` (the part after `/blob`). The area is the first
 * segment and must be namespaced (`blog:public`); the rest is the path.
 */
export function parseBlobRoute(pathname: string): { area: string; path: string } | null {
  const trimmed = pathname.replace(/^\/+/, '').replace(/^blob\//, '')
  const slash = trimmed.indexOf('/')
  if (slash <= 0) return null
  let area: string
  let path: string
  try {
    area = decodeURIComponent(trimmed.slice(0, slash))
    path = decodeURIComponent(trimmed.slice(slash + 1))
  } catch {
    return null // a malformed %-escape is a bad route, not a 500
  }
  if (!area.includes(':')) return null
  return { area, path }
}

export interface BlobRequest {
  method: string
  pathname: string
  contentType?: string
  body?: Uint8Array
  json?: Record<string, unknown>
  userRoles: UserRoles
}

export async function handleBlob(req: BlobRequest, deps: BlobDeps): Promise<BlobResponse> {
  if (req.method === 'POST') return move(req, deps)

  const route = parseBlobRoute(req.pathname)
  if (!route) {
    return { kind: 'error', status: 400, error: 'bad-request', message: 'expected /blob/<area>/<path>' }
  }
  const { area, path } = route
  const collections = await deps.collectionsFor(area)
  const config = collections[area]
  // Not an area (or not visible to the caller at all) — opaque.
  if (!isBlobStore(config)) return notFound

  switch (req.method) {
    case 'GET': {
      if (validateBlobPath(path)) return notFound
      const meta = await deps.getMeta(metaPath(area, path))
      if (!meta) return notFound
      const d = await decideRead(collections, area, meta, req.userRoles)
      if (d.status === 'refused') return refused(d, deps, req.userRoles)
      const key = objectKey(area, path, meta.sha256)
      const ttl = d.status === 'public' ? PUBLIC_SIGN_TTL : d.ttlSeconds
      const isPublic = d.status === 'public'
      const url = await deps.objects.url(key, ttl)
      return url
        ? { kind: 'redirect', url, cacheControl: isPublic ? PUBLIC_REDIRECT_CACHE : PRIVATE_CACHE }
        : {
            kind: 'stream',
            key,
            contentType: meta.contentType,
            cacheControl: isPublic ? PUBLIC_STREAM_CACHE : PRIVATE_CACHE,
            headers: deliveryHeaders(meta.contentType),
          }
    }

    case 'PUT': {
      const body = req.body ?? new Uint8Array()
      if (body.byteLength > MAX_UPLOAD_BYTES) {
        return { kind: 'error', status: 413, error: 'too-large', message: `uploads are limited to ${MAX_UPLOAD_BYTES} bytes` }
      }
      // Size and hash are MEASURED here, never taken from the client.
      const sha256 = deps.sha256(body)
      const d = decidePut(
        collections,
        area,
        { path, contentType: req.contentType, bytes: body.byteLength, sha256 },
        req.userRoles
      )
      if (d.status === 'refused') return refused(d, deps, req.userRoles)

      const docPath = metaPath(area, path)
      const previous = await deps.getMeta(docPath)
      if (previous && previous.sha256 === d.meta.sha256 && previous.contentType === d.meta.contentType) {
        // "unchanged" confirms a guessed body matches the stored file — only
        // say so to a caller who may read it (0.3.0 review M3).
        const canRead = (await decideRead(collections, area, previous, req.userRoles)).status !== 'refused'
        return {
          kind: 'json',
          status: 200,
          body: { status: canRead ? 'unchanged' : 'replaced', path, bytes: d.meta.bytes, sha256 },
        }
      }
      if (previous && config?.immutable) {
        return { kind: 'error', status: 409, error: 'immutable', message: 'this area is immutable: a stored file cannot be replaced' }
      }

      const key = objectKey(area, path, d.meta.sha256)
      await deps.objects.put(key, body, d.meta.contentType)
      let outcome: CommitOutcome
      try {
        outcome = await deps.commitMeta(docPath, d.meta, collections, req.userRoles)
      } catch (e) {
        await releaseIfUnreferenced(deps, docPath, key, d.meta.sha256)
        throw e
      }
      if (outcome.status === 'refused') {
        await releaseIfUnreferenced(deps, docPath, key, d.meta.sha256)
        return { kind: 'error', status: commitStatus(outcome.refusal.reason), error: outcome.refusal.reason, message: outcome.refusal.message }
      }
      // Only now is the old object unreferenced.
      if (previous && previous.sha256 !== d.meta.sha256) {
        await deps.objects.delete(objectKey(area, path, previous.sha256)).catch(() => undefined)
      }
      return {
        kind: 'json',
        status: 200,
        body: { status: previous ? 'replaced' : 'stored', path, bytes: d.meta.bytes, sha256 },
      }
    }

    case 'DELETE': {
      const d = decideDelete(collections, area, path, req.userRoles)
      if (d.status === 'refused') return refused(d, deps, req.userRoles)
      if (config?.immutable) {
        return { kind: 'error', status: 409, error: 'immutable', message: 'this area is immutable: a stored file cannot be deleted' }
      }
      const docPath = metaPath(area, path)
      const meta = await deps.getMeta(docPath)
      if (!meta) return deps.isPrivileged(req.userRoles) ? { kind: 'error', status: 403, error: 'missing', message: 'no such file' } : notFound
      // Metadata FIRST: once it is gone the file is unreachable; a crash
      // between the two leaves an orphaned object, never a dangling document.
      await deps.deleteMeta(docPath)
      await deps.objects.delete(objectKey(area, path, meta.sha256)).catch(() => undefined)
      return { kind: 'json', status: 200, body: { status: 'deleted', path } }
    }

    default:
      return { kind: 'error', status: 400, error: 'bad-request', message: `unsupported method ${req.method}` }
  }
}

async function move(req: BlobRequest, deps: BlobDeps): Promise<BlobResponse> {
  const body = req.json ?? {}
  const from = body.from as { area?: unknown; path?: unknown } | undefined
  const to = body.to as { area?: unknown; path?: unknown } | undefined
  if (body.op !== 'move' || typeof from?.area !== 'string' || typeof to?.area !== 'string') {
    return { kind: 'error', status: 400, error: 'bad-request', message: 'expected {op: "move", from: {area, path}, to: {area, path}}' }
  }
  const collections = {
    ...(await deps.collectionsFor(from.area)),
    ...(await deps.collectionsFor(to.area)),
  }
  if (!isBlobStore(collections[from.area]) || !isBlobStore(collections[to.area])) return notFound
  if (validateBlobPath(from.path) || validateBlobPath(to.path)) {
    return { kind: 'error', status: 400, error: 'bad-request', message: 'invalid path' }
  }
  const src = await deps.getMeta(metaPath(from.area, from.path as string))
  if (!src) return notFound

  const d = await decideMove(
    collections,
    { area: from.area, path: from.path },
    { area: to.area, path: to.path },
    src,
    req.userRoles
  )
  if (d.status === 'refused') return refused(d, deps, req.userRoles)
  if (collections[from.area]?.immutable) {
    return { kind: 'error', status: 409, error: 'immutable', message: 'this area is immutable: a stored file cannot be moved out' }
  }
  // Never clobber: a move to an occupied path is refused, not a replace.
  if (await deps.getMeta(metaPath(to.area, to.path as string))) {
    return { kind: 'error', status: 403, error: 'exists', message: 'the destination already exists' }
  }

  const srcKey = objectKey(from.area, from.path as string, src.sha256)
  const dstKey = objectKey(to.area, to.path as string, src.sha256)
  const dstPath = metaPath(to.area, to.path as string)
  await deps.objects.copy(srcKey, dstKey)
  let outcome: CommitOutcome
  try {
    // POST: the destination must not exist AT COMMIT — the check above is a
    // courtesy; this is what stops two concurrent moves to one path clobbering.
    outcome = await deps.commitMeta(dstPath, d.meta, collections, req.userRoles, 'POST')
  } catch (e) {
    await releaseIfUnreferenced(deps, dstPath, dstKey, src.sha256)
    throw e
  }
  if (outcome.status === 'refused') {
    await releaseIfUnreferenced(deps, dstPath, dstKey, src.sha256)
    return { kind: 'error', status: commitStatus(outcome.refusal.reason), error: outcome.refusal.reason, message: outcome.refusal.message }
  }
  // The destination is committed; only now is the source removed.
  await deps.deleteMeta(metaPath(from.area, from.path as string))
  await deps.objects.delete(srcKey).catch(() => undefined)
  return { kind: 'json', status: 200, body: { status: 'moved', from: from.path, to: to.path } }
}
