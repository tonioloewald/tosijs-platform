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
 *
 * NOTE (2026-09-06): "rules stay predicates" is NOT the same as "rules are safe".
 * tjs-lang#52 corrupts predicates too, and upstream coerces a corrupted result to
 * a GRANT (tjs-lang#54) — so when the rule half is built, its host must interpret
 * results as `result === true`, never `!!result`, and rules must avoid bare
 * dot-path returns. Pinned in `tjs-lang.baseline.test.ts` §5-§6.
 */
import { validate as schemaValidate } from 'tosijs-schema'
import type { CollectionConfig } from './access.js'
import type { UserRoles } from './roles.js'

/** Envelope fields the endpoint owns; a body may never set them (§5). */
export const ENVELOPE_FIELDS = ['_id', '_collection', '_path'] as const

export type WriteMethod = 'POST' | 'PUT' | 'PATCH'

export interface WritePipelineDeps {
  /** Injected clock — ISO string. §4.1 forbids ambient time. */
  now: () => string
  /**
   * Privileged read for uniqueness (§4.2). Returns true when `value` is free for
   * `field` (or already belongs to the document being written).
   *
   * **Document identity is bound by the INJECTOR, not passed here** — this is a
   * partial application. `doc.ts`'s `isUnique(path, field, value, ref)` needs the
   * ref to exclude the document being written from its own collision check, and
   * both `path` and `ref` are request-scoped context the caller already holds. A
   * reviewer read the 2-arg shape as *dropping* self-exclusion and predicted every
   * re-save would fail at cutover (F12); it does not, but nothing showed the
   * intended binding. At the cutover site, wire it exactly like this:
   *
   * ```ts
   * { isUnique: (field, value) => isUnique(path, field, value, ref) }
   * ```
   *
   * An implementation that ignores identity WOULD break every update, so do not
   * write a fresh one.
   */
  isUnique: (field: string, value: unknown) => Promise<boolean>
}

export interface WritePipelineInput {
  method: WriteMethod
  /** The caller's proposed body. */
  body: Record<string, unknown>
  /** Stored document, or `{}`/null when creating. */
  existing: Record<string, unknown> | null
  /**
   * Whether the document exists, when the caller knows authoritatively.
   *
   * Omit and existence is inferred from `existing` being non-empty — which is
   * what the shadow-mode harness did and is right for every test fixture. It is
   * NOT right against a real store: Firestore permits an **empty document**
   * (`set({})`), for which `doc.exists` is `true` while `Object.keys(data)` is
   * empty. Inferring there would let a POST overwrite an existing document
   * instead of being refused, so `doc.ts` passes `doc.exists` explicitly.
   */
  exists?: boolean
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
      reason:
        | 'schema'
        | 'validate'
        | 'unique'
        | 'exists'
        | 'missing'
        | 'unattributed'
      message: string
      details?: Array<{ path: string; message: string }>
    }

/** Strip endpoint-owned envelope fields from a body (§5). */
/**
 * Fields the ENDPOINT writes, which a caller neither sends nor declares.
 *
 * Distinct from `ENVELOPE_FIELDS`, which a caller might send and which are
 * stripped from storage. These are stamped by the pipeline itself, so they
 * exist only *after* any strip — and must be hidden from the caller's schema
 * rather than removed from the document.
 */
export const STAMPED_FIELDS = ['_created', '_modified', '_seq', '_by'] as const

/**
 * Who made this write, as the endpoint knows it — not as the writer said (#18).
 *
 * BETA.md promised "the token is the provenance … answerable from the record
 * rather than from a field the writer chose to populate honestly", and nothing
 * was stamped, so it was answerable only from exactly such a field. This is
 * that promise made true.
 *
 * **A token is NOT always present.** Three shapes reach a write:
 *
 *   - a capability token — uid, role document, token id and label;
 *   - a human's Firebase ID token — uid and role document, no token;
 *   - nobody, if an installed collection grants `public` write — no `_by` at
 *     all, which is the honest record of an unattributable write rather than
 *     an empty object pretending to be an identity.
 *
 * Kept small on purpose: it is paid on every document, forever. The id and the
 * label are what make a write attributable without a join; anything else can
 * be looked up from them.
 */
export function provenanceOf(
  userRoles: UserRoles
): Record<string, unknown> | undefined {
  const uid = userRoles.userIds?.[0]
  const token = userRoles.token
  if (!uid && !token) return undefined
  return {
    ...(uid ? { uid } : {}),
    ...(userRoles._id ? { role: userRoles._id } : {}),
    // A DISPLAY name, snapshotted deliberately. `uid`/`role` are the stable
    // references; this is what the principal was called at the time, so a
    // later rename does not rewrite history. That is the behaviour an audit
    // record wants, and the opposite of what a foreign key wants — hence
    // both are here.
    ...(userRoles.name && userRoles.name !== 'unknown'
      ? { name: userRoles.name }
      : {}),
    // The agent's own identity. Every token a person mints attenuates THEIR
    // authority, so `uid` is identical across all of them — the label is the
    // only thing that tells one agent from another, and from its human.
    ...(token ? { token: token.id, label: token.label } : {}),
  }
}

/** A document as its author wrote it: no envelope, no endpoint stamps. */
export function withoutStamps(
  data: Record<string, unknown>
): Record<string, unknown> {
  const content = { ...data }
  for (const field of STAMPED_FIELDS) delete content[field]
  return content
}

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
    const c = withoutStamps(stripEnvelope(o))
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
  const exists = input.exists ?? Object.keys(existing).length > 0

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
  // Provenance is stamped like the timestamps: endpoint-written, never taken
  // from the body, and hidden from the caller's schema (#16, #18).
  const by = provenanceOf(userRoles)

  // A collection may REQUIRE that every document be attributable.
  //
  // Checked here rather than at the access gate because it is not a question
  // about permission — a collection can legitimately grant `public` write and
  // still refuse an unattributable one. Opt-in, because "anyone may write,
  // anonymously" is a real and sometimes correct configuration; the point is
  // that it should be chosen rather than arrived at.
  if (config.requireAttribution && !by) {
    return {
      status: 'rejected',
      reason: 'unattributed',
      message: 'this collection requires an attributable principal',
    }
  }

  let data: Record<string, unknown> =
    method === 'PATCH'
      ? { ...existing, ...body, _created: created, _modified: modified }
      : { ...body, _created: created, _modified: modified }
  if (by) data._by = by
  else delete data._by

  // Envelope fields are endpoint-owned: strip so they are never stored back as
  // caller content.
  data = stripEnvelope(data)

  if (config.schema) {
    // Validate the CALLER'S CONTENT, not the document we just stamped.
    //
    // This comment used to claim the strip above covered it. It did not:
    // `stripEnvelope` removes `_id`/`_collection`/`_path`, which a caller might
    // SEND, but `_created`/`_modified` are written by the two lines above it,
    // after any strip could reach them. So every closed schema
    // (`additionalProperties: false`) rejected every write with
    // "Unexpected _created" — reported by the first consumer to try one
    // (tosijs-platform#16), and it makes a closed schema unusable, which is
    // precisely the schema an append-only log wants.
    //
    // It also broke a promise that matters more than the feature: the same
    // JSON Schema validated locally accepted a document the host refused.
    const content = withoutStamps(data)
    const errors: Array<{ path: string; message: string }> = []
    // `strict: true` — see the identical note in `doc.ts`'s validateWithSchema.
    // Without it tosijs-schema stride-samples arrays past ~100 entries, so the
    // write gate would only spot-check long arrays. Kept in lockstep with
    // `doc.ts` deliberately: a divergence here is a shadow-mode false match.
    const valid = schemaValidate(content, config.schema, {
      onError: (path: string, message: string) => {
        errors.push({ path, message })
      },
      strict: true,
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
