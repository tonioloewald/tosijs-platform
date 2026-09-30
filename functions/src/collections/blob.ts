/**
 * Blob storage — the pure decision layer (board #1136, step 1).
 *
 * ## The model (owner, 2026-09-28)
 *
 * **A storage area is a collection.** It is namespaced like one (`blog:public`,
 * `blog:private`, `virta:attachments`) and permissioned exactly like one — the
 * same `access` map, the same lattice join, the same visibility filters, the
 * same deny-by-default. Each file has a METADATA DOCUMENT in that collection
 * (`BlobMeta`), so listing and filtering files is ordinary `/docs`, under the
 * same rules, and provenance (`_by`) applies to files like everything else.
 * The bytes live in a substrate (GCS first, R2 later) behind an adapter, keyed
 * by area and path; nothing here knows which.
 *
 * A collection is a storage area when its config carries `blob` (limits).
 * There is no second permission system: that is the point.
 *
 * ## Public vs private is DERIVED, not declared
 *
 * An area is public exactly when an anonymous caller may read it
 * unconditionally (`public: { read: ALL }`). Then a file is served at a stable,
 * cacheable URL — what an RSS enclosure or an embedded image needs. Anything
 * else (a signed-in reader, or a visibility filter on the metadata) is
 * private: served by a short-lived signed link issued only after the access
 * check passes. A separate `public: true` flag could disagree with the rules;
 * deriving it cannot.
 *
 * ## Pure
 *
 * No I/O, no clock, no substrate: every decision is a function of the config,
 * the principal and the request, so it is tested without a store. The endpoint
 * (step 2) commits what this decides.
 */
import {
  ALL,
  getMethodAccess,
  type CollectionConfig,
  type CollectionMap,
  type REST_METHOD,
} from './access.js'
import { anonymousUser, type UserRoles } from './roles.js'

/** The limits that make a collection a storage area. */
export interface BlobLimits {
  /** Largest file accepted, in bytes. Required: an unbounded store is a bill. */
  maxBytes: number
  /**
   * Accepted content types: exact (`image/png`) or a family (`image/*`).
   * Absent means any type. Compared without parameters, case-insensitively.
   */
  contentTypes?: string[]
}

/** The metadata document stored for each file, in the area's collection. */
export interface BlobMeta {
  /** The file's path within the area, e.g. `2026/cover.webp`. */
  path: string
  contentType: string
  bytes: number
  /** Hex sha256 of the bytes — lets a reader verify, and a writer dedupe. */
  sha256: string
  width?: number
  height?: number
}

/**
 * The JSON Schema of a metadata document — the default schema of a storage
 * area. Only the /blob endpoint writes these documents (direct /doc writes to
 * an area are refused), so this describes exactly what it writes.
 */
export const BLOB_META_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    contentType: { type: 'string' },
    bytes: { type: 'integer', minimum: 0 },
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
  },
  required: ['path', 'contentType', 'bytes', 'sha256'],
} as const

/** Refusal reasons. `forbidden` is answered opaquely to non-privileged callers. */
export type BlobRefusal =
  | { status: 'refused'; reason: 'forbidden'; message: string }
  | { status: 'refused'; reason: 'path' | 'too-large' | 'type' | 'bad-request'; message: string }

export const isBlobStore = (config: CollectionConfig | undefined): boolean =>
  Boolean(config?.blob)

// ── paths ──────────────────────────────────────────────────────────────────

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const MAX_BLOB_PATH = 512

/**
 * Is `path` a safe file path within an area?
 *
 * Deliberately narrow: segments of letters, digits, `.`, `_`, `-`, not
 * starting with a dot (no `.`/`..`, no hidden files), separated by single
 * `/`. It becomes both a substrate key and part of a URL, so anything that
 * would need escaping — or could climb out of the area — is refused rather
 * than normalised.
 */
export function validateBlobPath(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return 'a path is required'
  if (path.length > MAX_BLOB_PATH) return `a path is at most ${MAX_BLOB_PATH} characters`
  const segments = path.split('/')
  for (const s of segments) {
    if (!SEGMENT.test(s)) {
      return `"${path}" has an invalid segment — use letters, digits, ".", "_" and "-", not starting with "."`
    }
  }
  return null
}

/**
 * The metadata document's id for a path. Firestore ids cannot contain `/`, and
 * a path legitimately does, so `/` becomes `~` (which a valid path cannot
 * contain — see SEGMENT), keeping the mapping one-to-one and reversible.
 */
export const blobDocId = (path: string): string => path.replace(/\//g, '~')
export const blobPathFromDocId = (id: string): string => id.replace(/~/g, '/')

// ── content types ──────────────────────────────────────────────────────────

const bareType = (contentType: string): string =>
  contentType.split(';')[0].trim().toLowerCase()

/**
 * Exactly ONE media type, `type/subtype` in RFC 7231 token characters. Anything
 * else — above all a comma-joined list like `image/png, text/html` — is
 * refused, not interpreted: browsers take the LAST type of a list, so a
 * prefix check on the first one let HTML through an `image/*` allowlist
 * (0.3.0 review B1).
 */
const SINGLE_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/
export const isSingleMediaType = (contentType: string): boolean =>
  SINGLE_TYPE.test(bareType(contentType))

export function contentTypeAllowed(contentType: string, allowed?: string[]): boolean {
  if (!isSingleMediaType(contentType)) return false
  if (!allowed || allowed.length === 0) return true
  const type = bareType(contentType)
  return allowed.some((pattern) => {
    const p = pattern.trim().toLowerCase()
    return p.endsWith('/*') ? type.startsWith(p.slice(0, -1)) : type === p
  })
}

// ── access ─────────────────────────────────────────────────────────────────

const decision = (
  collections: CollectionMap,
  area: string,
  method: REST_METHOD,
  userRoles: UserRoles
) => getMethodAccess(collections, area, method, userRoles)

/**
 * Is this area PUBLIC — readable by anyone, unconditionally? Derived from the
 * access rules (see the header), so it can never disagree with them.
 */
export function isPublicArea(collections: CollectionMap, area: string): boolean {
  return (
    isBlobStore(collections[area]) &&
    decision(collections, area, 'GET', anonymousUser) === ALL
  )
}

export type ReadDecision =
  | { status: 'public' } // serve the stable, cacheable URL
  | { status: 'signed'; ttlSeconds: number } // issue a short-lived signed link
  | BlobRefusal

/** Default life of a signed link for a private file. */
export const SIGNED_TTL_SECONDS = 300

/**
 * May `userRoles` read the file described by `meta` in `area`, and how is it
 * delivered?
 *
 * A filter grant (a visibility rule) is evaluated against the METADATA
 * document — the same row `/docs` would filter — so a rule like "tagged
 * public" means the same thing for the file as for its listing.
 */
export async function decideRead(
  collections: CollectionMap,
  area: string,
  meta: BlobMeta & Record<string, unknown>,
  userRoles: UserRoles
): Promise<ReadDecision> {
  if (!isBlobStore(collections[area])) {
    return { status: 'refused', reason: 'forbidden', message: 'not found' }
  }
  if (isPublicArea(collections, area)) return { status: 'public' }
  const access = decision(collections, area, 'GET', userRoles)
  if (access === ALL) return { status: 'signed', ttlSeconds: SIGNED_TTL_SECONDS }
  if (typeof access === 'function') {
    const row = await access(meta, userRoles)
    if (!(row instanceof Error)) {
      return { status: 'signed', ttlSeconds: SIGNED_TTL_SECONDS }
    }
  }
  return { status: 'refused', reason: 'forbidden', message: 'not found' }
}

export interface PutRequest {
  path: unknown
  contentType: unknown
  bytes: unknown
  sha256: unknown
  width?: unknown
  height?: unknown
}

export type PutDecision = { status: 'allowed'; meta: BlobMeta } | BlobRefusal

const HEX64 = /^[0-9a-f]{64}$/

/**
 * May `userRoles` store this file in `area`?
 *
 * WRITE access must be unconditional (`ALL`): a filter grant on write is a
 * restriction the write path cannot honour, and — as for collections (review
 * F1) — it fails CLOSED rather than being read as permission.
 */
export function decidePut(
  collections: CollectionMap,
  area: string,
  request: PutRequest,
  userRoles: UserRoles
): PutDecision {
  const config = collections[area]
  if (!isBlobStore(config)) {
    return { status: 'refused', reason: 'forbidden', message: 'not found' }
  }
  if (decision(collections, area, 'PUT', userRoles) !== ALL) {
    return { status: 'refused', reason: 'forbidden', message: 'not found' }
  }
  const limits = config.blob as BlobLimits

  const pathProblem = validateBlobPath(request.path)
  if (pathProblem) return { status: 'refused', reason: 'path', message: pathProblem }
  const path = request.path as string

  if (typeof request.contentType !== 'string' || !isSingleMediaType(request.contentType)) {
    return { status: 'refused', reason: 'bad-request', message: 'exactly one content type like "image/png" is required' }
  }
  const contentType = bareType(request.contentType)
  if (!contentTypeAllowed(contentType, limits.contentTypes)) {
    return {
      status: 'refused',
      reason: 'type',
      message: `"${contentType}" is not accepted here — allowed: ${limits.contentTypes?.join(', ')}`,
    }
  }

  const bytes = request.bytes
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    return { status: 'refused', reason: 'bad-request', message: 'bytes must be a non-negative integer' }
  }
  if (bytes > limits.maxBytes) {
    return {
      status: 'refused',
      reason: 'too-large',
      message: `${bytes} bytes exceeds this area's limit of ${limits.maxBytes}`,
    }
  }
  if (typeof request.sha256 !== 'string' || !HEX64.test(request.sha256)) {
    return { status: 'refused', reason: 'bad-request', message: 'sha256 must be 64 lowercase hex digits' }
  }

  const dimension = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
  const width = dimension(request.width)
  const height = dimension(request.height)

  return {
    status: 'allowed',
    meta: {
      path,
      contentType,
      bytes,
      sha256: request.sha256,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    },
  }
}

export type DeleteDecision = { status: 'allowed' } | BlobRefusal

/** May `userRoles` delete a file from `area`? Unconditional DELETE access only. */
export function decideDelete(
  collections: CollectionMap,
  area: string,
  path: unknown,
  userRoles: UserRoles
): DeleteDecision {
  if (!isBlobStore(collections[area])) {
    return { status: 'refused', reason: 'forbidden', message: 'not found' }
  }
  if (decision(collections, area, 'DELETE', userRoles) !== ALL) {
    return { status: 'refused', reason: 'forbidden', message: 'not found' }
  }
  const problem = validateBlobPath(path)
  if (problem) return { status: 'refused', reason: 'path', message: problem }
  return { status: 'allowed' }
}

/**
 * May `userRoles` move a file? A move READS the source, deletes it, and puts
 * it at the destination, so it needs all three — and it is committed on the
 * server as one operation (step 2), never as the browser's old
 * copy-then-delete. Without the read, a write-only role (a drop box) could
 * move a file it may not read into an area it can (0.3.0 review M3).
 */
export async function decideMove(
  collections: CollectionMap,
  from: { area: string; path: unknown },
  to: { area: string; path: unknown },
  meta: BlobMeta & Record<string, unknown>,
  userRoles: UserRoles
): Promise<PutDecision> {
  const read = await decideRead(collections, from.area, meta, userRoles)
  if (read.status === 'refused') return read
  const del = decideDelete(collections, from.area, from.path, userRoles)
  if (del.status === 'refused') return del
  // The destination re-checks limits: moving a 5 MB file into a 1 MB area is
  // refused exactly as uploading it would be.
  return decidePut(
    collections,
    to.area,
    { ...meta, path: to.path },
    userRoles
  )
}

/** Problems with a declared `blob` limits object (manifest validation). */
export function blobLimitsProblems(blob: unknown, where: string): string[] {
  if (blob === null || typeof blob !== 'object' || Array.isArray(blob)) {
    return [`${where}: must be an object with maxBytes`]
  }
  const b = blob as Record<string, unknown>
  const problems: string[] = []
  if (typeof b.maxBytes !== 'number' || !Number.isInteger(b.maxBytes) || b.maxBytes <= 0) {
    problems.push(`${where}.maxBytes: required, a positive integer — an unbounded store is a bill`)
  }
  if (b.contentTypes !== undefined) {
    if (
      !Array.isArray(b.contentTypes) ||
      b.contentTypes.some((t) => typeof t !== 'string' || !/^[a-z0-9.+-]+\/(\*|[a-z0-9.+-]+)$/i.test(t))
    ) {
      problems.push(`${where}.contentTypes: must be types like "image/png" or families like "image/*"`)
    }
  }
  for (const k of Object.keys(b)) {
    if (k !== 'maxBytes' && k !== 'contentTypes') problems.push(`${where}.${k}: unknown key`)
  }
  return problems
}
