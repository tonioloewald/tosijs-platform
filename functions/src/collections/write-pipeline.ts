/**
 * The write pipeline (UNIVERSAL-ENDPOINT.md §3), extracted as a pure unit.
 *
 * ROADMAP Phase 1 rung 1 is "the universal `doc`/`docs` behaviourally replace the
 * existing endpoints — run in shadow mode until the diff is clean, then cut over."
 * This is the shadow-mode half: the same ordering as `doc.ts`'s inline write path,
 * but with every ambient dependency injected and every outcome *returned* rather
 * than written to an `express` response.
 *
 * NOT WIRED IN YET, deliberately. `doc.ts` still owns the production path; this
 * runs beside it (and under test) until the diff is clean. Cutting over is a
 * separate, reviewable change.
 *
 * Why this shape:
 *
 * - **Injected clock** (§4.1: "`Date.now()` … not available; time comes from the
 *   injected clock"). `doc.ts` calls `new Date()` mid-pipeline, which is why its
 *   stamping can only be tested against a live emulator.
 * - **Injected privileged read** (`isUnique`) — §4.2 puts uniqueness behind a rule
 *   with a privileged read and no write. Here it stays an injected capability, so
 *   the pipeline is testable without Firestore.
 * - **Typed outcome, no side effects.** The caller commits; the pipeline decides.
 *   The endpoint keeps its own HTTP mapping.
 * - **Ordering is a security property** (§3): the no-op check and `isWriteAllowed`
 *   both see post-transform data, so a transform cannot launder a write past a rule.
 *
 * Per ROADMAP Phase 0 (decided 2026-09-05, tjs-lang#52) the *transform* half stays
 * compiled TCB — this file — while ajs rules stay pure boolean predicates. So this
 * is trusted code: it is the thing a silent wrong value would persist.
 */
import { validate as schemaValidate } from 'tosijs-schema'
import type { CollectionConfig } from './access'
import type { UserRoles } from './roles'

/** Envelope fields the endpoint owns; a body may never set them (§5). */
export const ENVELOPE_FIELDS = ['_id', '_collection', '_path'] as const

export type WriteMethod = 'POST' | 'PUT' | 'PATCH'

export interface WritePipelineDeps {
  /** Injected clock — ISO string. §4.1 forbids ambient time. */
  now: () => string
  /**
   * Privileged read for uniqueness (§4.2). Returns true when `value` is free for
   * `field` (or already belongs to the document being written).
   */
  isUnique: (field: string, value: unknown) => Promise<boolean>
}

export interface WritePipelineInput {
  method: WriteMethod
  /** The caller's proposed body. */
  body: Record<string, unknown>
  /** Stored document, or `{}`/null when creating. */
  existing: Record<string, unknown> | null
  config: CollectionConfig
  userRoles: UserRoles
}

/**
 * Typed outcome. `noop` is a distinct success: the spec requires that an
 * unchanged body neither writes nor re-stamps, which the current `doc.ts` does
 * NOT do (it re-stamps `_modified` on every PUT). Callers must treat `noop` as
 * success, not as "nothing happened, try again".
 */
export type WriteOutcome =
  | { status: 'write'; data: Record<string, unknown> }
  | { status: 'noop' }
  | {
      status: 'rejected'
      reason: 'schema' | 'validate' | 'unique' | 'exists' | 'missing'
      message: string
      details?: Array<{ path: string; message: string }>
    }

/** Strip endpoint-owned envelope fields from a body (§5). */
export function stripEnvelope(
  data: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...data }
  for (const f of ENVELOPE_FIELDS) delete out[f]
  return out
}

/**
 * Compare a proposed body against the stored one for the §3 no-op check.
 * Envelope + provenance fields are excluded: they are endpoint-owned, so a
 * difference in `_modified` is not a difference in *content*.
 */
export function isUnchanged(
  next: Record<string, unknown>,
  prev: Record<string, unknown> | null
): boolean {
  if (prev == null || Object.keys(prev).length === 0) return false
  const strip = (o: Record<string, unknown>) => {
    const c = stripEnvelope(o)
    delete c._created
    delete c._modified
    return c
  }
  return stableStringify(strip(next)) === stableStringify(strip(prev))
}

/** Key-order-independent structural compare, so field order never forces a write. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const o = value as Record<string, unknown>
  const keys = Object.keys(o).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

/**
 * Run the write pipeline. Mirrors `doc.ts`'s ordering
 * (existence guard → merge+stamp → strip envelope → schema → validate → unique)
 * with the §3 no-op check added before the expensive privileged reads.
 */
export async function runWritePipeline(
  input: WritePipelineInput,
  deps: WritePipelineDeps
): Promise<WriteOutcome> {
  const { method, body, config, userRoles } = input
  const existing = input.existing ?? {}
  const exists = Object.keys(existing).length > 0

  // Existence guards — POST creates, PUT/PATCH update.
  if (exists && method === 'POST') {
    return {
      status: 'rejected',
      reason: 'exists',
      message: 'document already exists',
    }
  }
  if (!exists && method !== 'POST') {
    return {
      status: 'rejected',
      reason: 'missing',
      message: 'cannot update non-existent document',
    }
  }

  const modified = deps.now()
  const created = (existing._created as string) || modified

  // PATCH merges over stored content; POST/PUT replace.
  let data: Record<string, unknown> =
    method === 'PATCH'
      ? { ...existing, ...body, _created: created, _modified: modified }
      : { ...body, _created: created, _modified: modified }

  // Envelope fields are endpoint-owned: strip before validation so a strict
  // schema doesn't reject them, and never store them back as content.
  data = stripEnvelope(data)

  if (config.schema) {
    const errors: Array<{ path: string; message: string }> = []
    const valid = schemaValidate(data, config.schema, (path, message) => {
      errors.push({ path, message })
    })
    if (!valid) {
      return {
        status: 'rejected',
        reason: 'schema',
        message: 'schema validation failed',
        details: errors,
      }
    }
  }

  // The transform (§4.1 beforeWrite). Compiled TCB per ROADMAP Phase 0.
  if (config.validate) {
    const result = await config.validate(data, userRoles, existing)
    if (result instanceof Error) {
      return {
        status: 'rejected',
        reason: 'validate',
        message: result.message || 'validation failed',
      }
    }
    data = stripEnvelope(result as Record<string, unknown>)
  }

  // §3 no-op check — AFTER the transform, so it compares what would actually
  // land. Placed before the uniqueness reads because an unchanged body cannot
  // introduce a collision, and this is the stage that avoids privileged I/O.
  if (isUnchanged(data, existing)) {
    return { status: 'noop' }
  }

  // Uniqueness (§4.2): privileged read, reject-only — it can refuse a duplicate
  // but never mint a value.
  for (const field of config.unique || []) {
    if (!(await deps.isUnique(field, data[field]))) {
      return {
        status: 'rejected',
        reason: 'unique',
        message: `"${field}" is required to exist and be unique`,
      }
    }
  }

  return { status: 'write', data }
}
