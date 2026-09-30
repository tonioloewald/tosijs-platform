/**
 * The legacy storage folders: the ONLY part of the bucket that anything but
 * /blob may read (0.3.0 re-review 2, B1).
 *
 * The default bucket has more than one reader. /blob serves storage areas
 * under their own access rules; the older readers — /stored (Admin SDK, so
 * storage.rules never applies to it) and direct client access (storage.rules)
 * — predate areas. Each was patched in turn to EXCLUDE areas, and each round
 * found another reader that did not. So the legacy readers now name what they
 * MAY read instead: these folders, and nothing else. An area's objects are
 * out of their reach by construction, whatever an area key looks like.
 *
 * storage.rules mirrors this list; scripts/storage-rules.test.ts checks that
 * the two agree.
 */
export const LEGACY_FOLDERS = ['blog', 'public', 'users'] as const

/**
 * Decode a legacy path and check that it lies inside a legacy folder.
 * Returns the decoded object path, or null for anything else (including a
 * malformed escape, a traversal, or an empty segment).
 */
export function legacyObjectPath(raw: string): string | null {
  let path: string
  try {
    path = decodeURIComponent(raw)
  } catch {
    return null
  }
  const segments = path.split('/')
  if (segments.length < 2) return null
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null
  if (!(LEGACY_FOLDERS as readonly string[]).includes(segments[0])) return null
  return path
}
