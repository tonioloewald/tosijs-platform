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
  DeriveOp,
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
      case 'lte':
      case 'gte': {
        // Never coerce across types: `'10' <= 9` is a comparison nobody meant,
        // and for a capability CEILING a surprising true is a granted excess.
        // Mismatched types deny.
        if (typeof held !== typeof value) return false
        if (typeof held !== 'number' && typeof held !== 'string') return false
        return op === 'lte'
          ? held <= (value as typeof held)
          : held >= (value as typeof held)
      }
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

/** URL slug, matching the client's `slugify` so both ends agree. */
const slugify = (text: string): string =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled'

const SHORT_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export interface DeriveContext {
  /** Injected clock — §4.1 forbids ambient time in a transform. */
  now: () => string
  /** Injected randomness, so `shortId` is deterministic under test. */
  random: () => number
  principal: { uid?: string; name?: string; roleId?: string }
}

/**
 * Compile `derive` ops into the transform half of a collection config.
 *
 * This is what replaces a hand-written `validate` for declarative collections —
 * the reason `post` can stop being TypeScript. A CLOSED registry of
 * parameterised operations, not a language: the manifest SELECTS a transform, it
 * never carries code. An unknown op cannot appear (the validator refuses it) and
 * would be ignored here rather than guessed at.
 *
 * Ops only ever ADD or NORMALISE fields the caller could have sent. None of them
 * touches the envelope, so provenance stays unforgeable (§5).
 */
export function compileDerive(
  ops: DeriveOp[],
  ctx: DeriveContext
): (data: Record<string, unknown>) => Record<string, unknown> {
  return (data) => {
    const out = { ...data }
    for (const op of ops) {
      switch (op.op) {
        case 'slug': {
          const current = String(out[op.to] ?? '').trim()
          if (op.when === 'always' || !current) {
            out[op.to] = slugify(String(out[op.from] ?? ''))
          } else {
            // Normalise what the author typed, so a hand-entered slug and a
            // generated one cannot disagree about what is legal.
            out[op.to] = slugify(current)
          }
          break
        }
        case 'shortId': {
          if (out[op.to] === undefined || out[op.to] === '') {
            const n = op.length ?? 8
            let id = ''
            for (let i = 0; i < n; i++) {
              id +=
                SHORT_ID_ALPHABET[
                  Math.floor(ctx.random() * SHORT_ID_ALPHABET.length)
                ]
            }
            out[op.to] = id
          }
          break
        }
        case 'now':
          if (!out[op.to]) out[op.to] = ctx.now()
          break
        case 'principal':
          if (!out[op.to]) {
            out[op.to] =
              (ctx.principal as Record<string, string | undefined>)[op.field] ??
              ''
          }
          break
        case 'constant':
          out[op.to] = op.value
          break
        default:
          // Unreachable through the validator. Ignored rather than guessed.
          break
      }
    }
    return out
  }
}

/**
 * Compile `envelope.version.bumpOn` — endpoint-managed revision counting.
 *
 * `module` maintains a `revisions` count that increments when `source` changes
 * and is CARRIED FORWARD otherwise. That carry-forward is not incidental: PUT
 * replaces the document, so a branch that failed to reassign the field silently
 * erased a module's entire revision history (found 2026-09-06).
 *
 * Expressing it declaratively removes the bug class rather than the bug — the
 * caller cannot send the field at all, so there is no branch left to forget.
 */
export function compileVersionBump(
  field: string,
  bumpOn: string[]
): (
  data: Record<string, unknown>,
  existing: Record<string, unknown>
) => Record<string, unknown> {
  return (data, existing) => {
    const out = { ...data }
    const isUpdate = existing && Object.keys(existing).length > 0
    if (!isUpdate) {
      out[field] = 0
      return out
    }
    const changed = bumpOn.some((f) => existing[f] !== data[f])
    const previous = Number(existing[field] ?? 0)
    out[field] = changed ? previous + 1 : previous
    return out
  }
}

export interface CompileOptions {
  /** Injected so derived values are deterministic under test (§4.1). */
  now?: () => string
  random?: () => number
}

/** Compile one installed collection into a `CollectionConfig`. */
export function compileCollection(
  collection: InstalledCollection,
  options: CompileOptions = {}
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

  // `derive` and `envelope.version` compose into the single `validate` slot the
  // write pipeline already calls. Order matters: derive first (it may create the
  // field a version bump compares), then the version bump, which the caller can
  // never influence because it runs last and overwrites.
  // `envelope.seq` is a flag the COMMIT path reads, not a transform: the
  // sequence is assigned inside the same transaction as the document write, so
  // nothing the pipeline could compute would be atomic with it.
  if (collection.envelope?.seq === true) config.seq = true

  const derive = collection.derive?.length
    ? compileDerive(collection.derive, {
        now: options.now ?? (() => new Date().toJSON()),
        random: options.random ?? Math.random,
        principal: {},
      })
    : null
  const bump = collection.envelope?.version?.bumpOn?.length
    ? compileVersionBump('revisions', collection.envelope.version.bumpOn)
    : null

  if (derive || bump) {
    config.validate = async (
      data: Record<string, unknown>,
      _roles: unknown,
      existing: Record<string, unknown>
    ) => {
      let out = data
      if (derive) out = derive(out)
      if (bump) out = bump(out, existing ?? {})
      return out
    }
  }

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
