/**
 * Collection namespacing (tosijs-platform#5, #7).
 *
 * `COLLECTIONS` is a flat map. Today it holds `post`, `page`, `module`,
 * `config`, `role` — a shared global space that works only because one team
 * owns all of it. An install system hands that space to third parties: the
 * first two libraries that both want a `task` collection collide, and the
 * second one silently takes over the first one's data.
 *
 * So installed collections are namespaced: `virta:task`, `blog:post`.
 *
 * ## Why `:` and not `/`
 *
 * `/` is ALREADY the sub-collection separator. `collectionPath()` splits a
 * document path on `/` and keeps the even segments, so `virta/task` is
 * indistinguishable from "sub-collection `task` of collection `virta`", and
 * `/doc?p=virta/task/abc` would parse as a three-segment path with an odd
 * number of parts. `:` rides inside a single segment, so:
 *
 *   - `collectionPath()` needs no change;
 *   - `/doc?p=virta:task/abc` and `/docs?p=virta:task` parse as they always did;
 *   - sub-collections still work: `virta:task/comment`.
 *
 * `:` is also legal in a Firestore collection id (the documented restrictions
 * are: no `/`, not `.` or `..`, must not match `__.*__`, ≤1500 bytes) and needs
 * no encoding in a query string.
 *
 * ## Logical vs physical
 *
 * A manifest names LOGICAL collections and never the substrate — that is the
 * promise in #7 that keeps the Postgres path open. `physicalCollection()` is the
 * mapping, and it is the identity function today. The indirection exists so the
 * day it stops being the identity (Postgres wants `virta_task`, not
 * `virta:task`) nothing above it changes.
 */

/** Separates a namespace from a collection name. NOT `/`. See the header. */
export const NAMESPACE_SEPARATOR = ':'

/**
 * Collections the platform owns. A manifest may never declare these, because
 * whoever writes `role` rewrites the input to their own authorization (D4), and
 * `module` is served as executable JavaScript by `/esm`.
 *
 * The rule is broader than this list: an installed collection MUST be
 * namespaced, so any bare name is reserved whether or not it exists yet. The
 * list is what makes the error message useful.
 */
export const PLATFORM_COLLECTIONS = [
  'post',
  'page',
  'module',
  'config',
  'role',
  // Not built yet, named now so a manifest cannot claim them first.
  'manifest',
  'grant',
  'install-log',
  'token',
] as const

/** `^[a-z][a-z0-9-]{1,31}$` — npm-ish, and safe in a URL and a table name. */
export const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
/** A collection's own name, within a namespace. */
export const COLLECTION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

export interface ParsedCollection {
  /** null for a platform collection (a bare name). */
  namespace: string | null
  /** The name within the namespace, or the bare name. */
  name: string
  /** The full logical name as written. */
  logical: string
}

/**
 * Split a LOGICAL collection name into namespace and name.
 *
 * Operates on ONE path segment — callers that hold a document path should split
 * on `/` first. Returns an Error rather than throwing so callers can map it to
 * a 404 without a try/catch, matching `getRef`.
 */
export function parseCollection(segment: string): ParsedCollection | Error {
  if (segment.includes('/')) {
    return new Error(
      `"${segment}" is a path, not a collection segment — split on "/" first`
    )
  }
  const parts = segment.split(NAMESPACE_SEPARATOR)
  if (parts.length === 1) {
    return { namespace: null, name: segment, logical: segment }
  }
  if (parts.length > 2) {
    return new Error(
      `"${segment}" has more than one "${NAMESPACE_SEPARATOR}"; namespaces do not nest`
    )
  }
  const [namespace, name] = parts
  if (!NAMESPACE_PATTERN.test(namespace)) {
    return new Error(`"${namespace}" is not a valid namespace`)
  }
  if (!COLLECTION_PATTERN.test(name)) {
    return new Error(`"${name}" is not a valid collection name`)
  }
  return { namespace, name, logical: segment }
}

/**
 * Namespaces the platform owns. No manifest may take one.
 *
 * `system:*` holds the claim ceremony (`system:claim`), the host marker that
 * decides whether verification probes may run (`system:host`), the install
 * registry and the sequence counters. All of it is safe ONLY because nothing
 * registers those collections, so deny-default makes them unreachable through
 * `/doc`. A library named `system` that declared them with public access would
 * have been one configurator approval away from reopening the claim, marking a
 * consumer's host a sandbox, or rewinding a counter — found in the 0.2.0-beta.3
 * review (M2). Bare names were already the platform's; this is the same rule
 * for the namespaced ones it uses.
 */
export const RESERVED_NAMESPACES = ['system'] as const

/** Does this segment fall in a namespace the platform owns? */
export const isReservedCollection = (segment: string): boolean => {
  const parsed = parseCollection(segment)
  return (
    !(parsed instanceof Error) &&
    parsed.namespace !== null &&
    (RESERVED_NAMESPACES as readonly string[]).includes(parsed.namespace)
  )
}

/** Is this a platform-owned (un-namespaced) collection? */
export const isPlatformCollection = (segment: string): boolean => {
  const parsed = parseCollection(segment)
  return !(parsed instanceof Error) && parsed.namespace === null
}

/**
 * May a manifest for `namespace` declare `segment`?
 *
 * Two independent refusals, because this is the gate that keeps one installed
 * library out of another's data AND out of the platform's:
 *   - a bare name is the platform's, always;
 *   - a namespaced name must match the declaring manifest's own namespace.
 *
 * Returns null when allowed, an Error explaining why not otherwise.
 */
export function refuseDeclaration(
  namespace: string,
  segment: string
): Error | null {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    return new Error(`"${namespace}" is not a valid namespace`)
  }
  if ((RESERVED_NAMESPACES as readonly string[]).includes(namespace)) {
    return new Error(`"${namespace}" is a reserved namespace; it belongs to the platform`)
  }
  const parsed = parseCollection(segment)
  if (parsed instanceof Error) return parsed

  if (parsed.namespace === null) {
    const known = (PLATFORM_COLLECTIONS as readonly string[]).includes(
      parsed.name
    )
    return new Error(
      `"${segment}" is ${known ? 'a platform collection' : 'un-namespaced'}; ` +
        `a manifest may only declare "${namespace}${NAMESPACE_SEPARATOR}*"`
    )
  }
  if (parsed.namespace !== namespace) {
    return new Error(
      `manifest "${namespace}" may not declare "${segment}" — ` +
        `that belongs to "${parsed.namespace}"`
    )
  }
  return null
}

/**
 * Map a LOGICAL collection segment to its physical name in the substrate.
 *
 * The identity function today: `:` is legal in a Firestore collection id, so
 * `virta:task` is stored under exactly that name and the existing data is
 * untouched. It exists so that a substrate with different rules (Postgres table
 * names cannot contain `:`) is a change HERE and nowhere else.
 */
export function physicalCollection(segment: string): string {
  return segment
}

/** Map every collection segment of a document path. Doc ids pass through. */
export function physicalPath(path: string): string {
  return path
    .split('/')
    .map((part, index) => (index % 2 === 0 ? physicalCollection(part) : part))
    .join('/')
}
