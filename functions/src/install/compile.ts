/**
 * Turn a validated manifest into a runnable `CollectionConfig` (A3, #5).
 *
 * This is the step that makes "install is a write, not a deployment" true: the
 * same `COLLECTIONS` shape `/doc` already consumes, produced from JSON at
 * runtime instead of from TypeScript at build time.
 *
 * Compilation is PURE — it takes data and returns config, touching no store and
 * no clock. That means an installed collection can be exercised against
 * `MemoryStore` before it is ever written anywhere, which is what makes install
 * testable rather than merely deployable.
 *
 * ## Only ever compiles what the validator accepted
 *
 * `validateManifest` is the gate; this assumes its output. The two are kept
 * apart on purpose — a compiler that also validates ends up doing neither job
 * completely, and the security-relevant decisions belong in one auditable place.
 * `compileManifest` re-checks nothing and therefore cannot disagree.
 */

import { ALL, type AccessConfig, type CollectionConfig } from '../collections/access'
import type {
  InstalledCollection,
  Manifest,
  Visibility,
  AccessGrant,
} from './manifest'

/**
 * Compile a `Visibility` into the boolean predicate the access engine wants.
 *
 * Returns a plain function over a row. The closed vocabulary exists because
 * `contains` is NOT enforced by tosijs-schema (measured), so the obvious
 * "visibility is a schema" design silently grants everything for exactly the
 * rule `page` and `module` use. See manifest.ts.
 */
export function compileVisibility(
  v: Visibility
): (row: Record<string, unknown>) => boolean {
  if ('schema' in v) {
    // A schema arm is legitimate for shape-based visibility; the manifest
    // validator has already refused schemas whose keywords are unenforced, so a
    // schema that reaches here means what it says.
    return () => true
  }
  if ('all' in v) {
    const parts = v.all.map(compileVisibility)
    return (row) => parts.every((p) => p(row))
  }
  if ('any' in v) {
    const parts = v.any.map(compileVisibility)
    return (row) => parts.some((p) => p(row))
  }
  const { field, op, value } = v
  return (row) => {
    const held = row?.[field]
    switch (op) {
      case 'includes':
        return Array.isArray(held) && held.includes(value)
      case 'eq':
        return held === value
      case 'neq':
        return held !== value
      case 'nonEmpty':
        // Matches `isPublished`: absent, empty and whitespace all count as
        // empty. D11 — the three "empty" shapes disagreeing was a live leak.
        return String(held ?? '').trim() !== ''
      case 'absent':
        return held === undefined || held === null
      default:
        // Unreachable via the validator, and a DENY if it ever were: an
        // unrecognised predicate must never read as a grant.
        return false
    }
  }
}

/**
 * Compile one grant into what `getMethodAccess` expects: `ALL`, or a filter
 * function returning the row (visible) or an Error (not).
 *
 * The projection is applied by straining the row through the declared
 * properties. Projection schemas are property-lists here rather than full
 * validation — `filter()` re-validates, so a projection marking a field
 * `required` would HIDE rows that lack it instead of projecting them, turning a
 * field restriction into a row restriction.
 */
export function compileGrant(grant: AccessGrant): typeof ALL | ((row: any) => Promise<any>) {
  if (grant === 'ALL') return ALL

  const visible = grant.visible ? compileVisibility(grant.visible) : () => true
  const project = grant.project
  const properties =
    project && typeof project.properties === 'object'
      ? Object.keys(project.properties as Record<string, unknown>)
      : null

  return async (row: Record<string, unknown>) => {
    if (!visible(row)) return new Error('not visible')
    if (!properties) return row
    const out: Record<string, unknown> = {}
    // `_path` is endpoint-owned and always travels — the existing field-map
    // strainer does the same, and callers rely on it to address the document.
    if ('_path' in row) out._path = row._path
    for (const key of properties) {
      if (key in row) out[key] = row[key]
    }
    return out
  }
}

/** Compile one installed collection into a `CollectionConfig`. */
export function compileCollection(
  collection: InstalledCollection
): CollectionConfig {
  const access: Record<string, AccessConfig> = {}
  for (const rule of collection.access) {
    const entry: AccessConfig = access[rule.role] ?? {}
    if (rule.read !== undefined) entry.read = compileGrant(rule.read) as never
    if (rule.list !== undefined) entry.list = compileGrant(rule.list) as never
    if (rule.write !== undefined) {
      // A restricted write cannot be honoured: the write path does not apply a
      // strainer, and `getMethodAccess` fails CLOSED on a non-ALL write (F1).
      // Compiling it to `ALL` would silently widen; compiling it to a function
      // makes the engine deny, which is the correct and already-tested outcome.
      entry.write =
        rule.write === 'ALL' ? ALL : (compileGrant(rule.write as never) as never)
    }
    access[rule.role] = entry
  }

  const config: CollectionConfig = { access }
  if (collection.schema) config.schema = collection.schema as never
  if (collection.unique) config.unique = collection.unique
  if (collection.tagFields) config.tagFields = collection.tagFields
  if (collection.cacheLatencySeconds !== undefined) {
    config.cacheLatencySeconds = collection.cacheLatencySeconds
  }
  return config
}

/**
 * Compile a whole manifest into collection configs, keyed by LOGICAL name.
 *
 * The caller merges these into the registry. Returned rather than installed so
 * that compiling is side-effect free and a manifest can be exercised — against
 * `MemoryStore`, in a test, with no host — before anything is written.
 */
export function compileManifest(
  manifest: Manifest
): Record<string, CollectionConfig> {
  const out: Record<string, CollectionConfig> = {}
  for (const [logical, collection] of Object.entries(manifest.collections)) {
    out[logical] = compileCollection(collection)
  }
  return out
}
