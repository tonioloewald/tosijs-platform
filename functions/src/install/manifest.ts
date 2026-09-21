/**
 * The install manifest (tosijs-platform#5) — types and a PURE validator.
 *
 * A manifest is what a library hands a host to be installed: logical
 * collections, their schemas, who may do what to them, and what capabilities it
 * needs. It is plain JSON — no builders, no closures — because "install is a
 * write, not a deployment" only means anything if the thing being written is
 * data.
 *
 * ## v1 is DECLARATIVE ONLY
 *
 * No stored ajs. tjs-lang is a validated but entirely unwired dependency here,
 * and tjs-lang#52/#54 corrupt transforms *and* predicates silently while
 * upstream coerces a corrupted result to a GRANT. Shipping caller-authored code
 * on top of that is not a trade worth making, so `functions` in a manifest is a
 * HARD FAILURE rather than an ignored field — silently dropping the executable
 * half of someone's manifest and reporting success is the worst option.
 *
 * ## The validator's job is to refuse
 *
 * Everything here runs before anything is installed, and every check exists
 * because the alternative is a specific, known failure — not out of tidiness.
 * Two of them come from measured behaviour of tosijs-schema 1.9.0 (see
 * `assertSafeSchema`), which is exactly the kind of thing a manifest author
 * cannot be expected to know.
 */

import {
  refuseDeclaration,
  NAMESPACE_PATTERN,
} from '../collections/namespace'

/** JSON Schema as data. Deliberately loose — the checks below are the gate. */
export type JsonSchema = Record<string, unknown>

export type DeriveOp =
  | { op: 'slug'; to: string; from: string; when?: 'absent' | 'always' }
  | { op: 'shortId'; to: string; length?: number }
  | { op: 'now'; to: string }
  | { op: 'principal'; to: string; field: 'uid' | 'name' | 'roleId' }
  | { op: 'constant'; to: string; value: string | number | boolean }

export const DERIVE_OPS = ['slug', 'shortId', 'now', 'principal', 'constant']

/**
 * Row visibility: a BOOLEAN, per D5.
 *
 * The schema arm would be enough if schemas could express everything, and they
 * cannot: `contains` is accepted but NOT ENFORCED by tosijs-schema 1.9.0
 * (measured — `{tags:['nope']}` passes `contains: {const:'public'}`), which is
 * precisely the rule `page` and `module` use today. Hence a small closed
 * predicate vocabulary rather than an expression language.
 */
export type Visibility =
  | { schema: JsonSchema }
  | {
      field: string
      op: 'includes' | 'eq' | 'neq' | 'nonEmpty' | 'absent' | 'lte' | 'gte'
      value?: string | number | boolean
    }
  | { all: Visibility[] }
  | { any: Visibility[] }

/**
 * `lte`/`gte` exist for CAPABILITY ceilings — `{field: 'bytes', op: 'lte',
 * value: 1000000}`. Without them the vocabulary cannot express the single most
 * common capability constraint, which would mean settling a shape already known
 * to be wrong. They work on rows too (date cutoffs), and never coerce across
 * types: a mismatched comparison denies rather than guessing.
 */
export const VISIBILITY_OPS = [
  'includes',
  'eq',
  'neq',
  'nonEmpty',
  'absent',
  'lte',
  'gte',
]

export type AccessGrant =
  | 'ALL'
  | { visible?: Visibility; project?: JsonSchema }

export interface AccessRule {
  role: string
  read?: AccessGrant
  list?: AccessGrant
  write?: 'ALL' | { visible?: Visibility; accept: JsonSchema }
}

export interface InstalledCollection {
  schema: JsonSchema
  unique?: string[]
  tagFields?: string[]
  derive?: DeriveOp[]
  immutable?: boolean
  cacheLatencySeconds?: number
  /**
   * Endpoint-managed provenance the caller may never send.
   *
   * `version.bumpOn` names the fields whose change increments a `revisions`
   * counter — how `module` tracks source revisions. Declaring it removes a bug
   * CLASS rather than a bug: PUT replaces the document, and a hand-written
   * branch that forgot to carry the count forward silently erased a module's
   * entire revision history (2026-09-06). A caller cannot send the field, so
   * there is no branch left to forget.
   */
  envelope?: {
    version?: { bumpOn: string[] }
    /**
     * Assign a monotonic per-collection `_seq` on commit, so a replica can
     * resume from a cursor (#14).
     *
     * Opt-in because a total order SERIALISES writes to the collection —
     * roughly one per second, through a single counter document. That is what
     * a total order is, not an implementation detail to engineer away:
     * sharding the counter would restore throughput and destroy the ordering.
     * Timestamps stay automatic and free everywhere; a sequence is a choice,
     * and it should be made by someone who has seen the number.
     */
    seq?: boolean
    /**
     * Refuse a write that cannot be attributed to a principal.
     *
     * The complement to the `_by` stamp: provenance is recorded whenever there
     * is a principal, and this says the collection will not accept a document
     * without one. Worth declaring on anything that is a record of who did
     * what — an event log, an audit trail, a comment thread.
     */
    requireAttribution?: boolean
  }
  /**
   * An ARRAY, not a role-keyed object. Object key order decided precedence
   * under the old engine, and a manifest's key order comes from a file nobody
   * treats as ordered. Grants are joined as a lattice (see `joinAccess`), so
   * order is meaningless — the array makes that explicit rather than implied.
   */
  access: AccessRule[]
}

/**
 * Capability kinds this host RECOGNISES. A closed vocabulary, like DERIVE_OPS
 * and for the same reason: an unrecognised kind cannot be enforced, and a
 * capability that is granted but unenforceable is worse than one refused.
 */
export const CAPABILITY_KINDS = ['blob', 'email', 'sms', 'outbound', 'turn']

/**
 * Kinds this host can currently ENFORCE. Deliberately empty.
 *
 * The shape is settled (#11); enforcement is not built. Recognising a kind and
 * enforcing it are different claims, and collapsing them would let a human
 * approve "this library may send email" for a power that no code grants and no
 * code limits. Declaring an unenforced capability is allowed — it is inert —
 * but the install response says so, because an approval prompt that overstates
 * what it is asking about is how people learn to stop reading them.
 */
export const ENFORCED_CAPABILITY_KINDS: string[] = []

/**
 * A capability a manifest declares — and says who may exercise it.
 *
 * ## `access` is INSIDE the capability, not beside it
 *
 * `addedCapabilities` diffs whole declarations, which is what stops
 * `maxBytes: 1000 → 999999` slipping through an upgrade unapproved. Widening
 * access from `admin` to `public` is at least as dangerous as raising a byte
 * limit, so the rules live here where that diff already sees them. Alongside,
 * an upgrade could quietly open a capability to everyone with no re-approval.
 *
 * ## Absent or empty `access` means NOBODY
 *
 * Deny by default, exactly as an unregistered collection is unreachable —
 * including for `owner`, whose real power is the datastore (D3) rather than an
 * in-system bypass. A capability with no rules is declared, inert, and safe;
 * the upgrade that later adds a rule re-triggers approval because the
 * declaration changed.
 */
export interface CapabilityDeclaration {
  kind: string
  /** Who may exercise it, and under what constraint on the ARGUMENTS. */
  access?: CapabilityAccessRule[]
  /** kind-specific arguments and limits. */
  [arg: string]: unknown
}

export interface CapabilityAccessRule {
  role: string
  /**
   * `'ALL'`, or a constraint on the call arguments.
   *
   * The same `AccessGrant` a collection uses, pointed at arguments instead of a
   * stored row — `visible` constrains ("the recipient must be a project
   * member", "bytes must be lte 1e6") and `project` narrows which arguments
   * may be passed at all. Argument clamping IS field projection, which is what
   * makes sharing the lattice legitimate rather than a pun.
   */
  use: AccessGrant
}

export interface Manifest {
  manifest: 1
  name: string
  version: string
  collections: Record<string, InstalledCollection>
  /**
   * Keyed by namespaced name, mirroring `collections`. An array carried no
   * identity, so an upgrade that reordered it looked like a change and one
   * that renamed a capability looked like none.
   */
  capabilities?: Record<string, CapabilityDeclaration>
  usesRoles?: string[]
  functions?: never
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Walk every nested object in a schema. */
function* walk(node: unknown): Generator<Record<string, unknown>> {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item)
    return
  }
  yield node as Record<string, unknown>
  for (const value of Object.values(node as Record<string, unknown>)) {
    yield* walk(value)
  }
}

/**
 * Refuse a schema that would not actually validate what it appears to.
 *
 * Both checks are measured behaviour of tosijs-schema 1.9.0, and BOTH are
 * needed because neither catches the other:
 *
 * 1. `unenforcedKeywords()` reports keywords the validator accepts but ignores
 *    — `contains` among them. A manifest using `contains` for row visibility
 *    would look enforced and let everything through.
 *
 * 2. `$predicate` is IN the enforced set, so `unenforcedKeywords()` returns
 *    `[]` for it, yet with no evaluator registered `validate()` returns true for
 *    anything. It is invisible to check (1) and fails OPEN, so it is refused by
 *    name. This is the one a manifest author could weaponise deliberately.
 *
 * `unenforced` is injected so this module stays pure and testable; the installer
 * passes tosijs-schema's real implementation.
 */
export function assertSafeSchema(
  schema: JsonSchema,
  where: string,
  unenforced: (s: JsonSchema) => string[]
): Error[] {
  const problems: Error[] = []

  for (const node of walk(schema)) {
    if ('$predicate' in node) {
      problems.push(
        new Error(
          `${where}: "$predicate" is not allowed — with no evaluator registered it ` +
            'accepts ANY value, and unenforcedKeywords() cannot see it'
        )
      )
      break
    }
  }

  let ignored: string[] = []
  try {
    ignored = unenforced(schema)
  } catch (e) {
    problems.push(new Error(`${where}: could not analyse schema: ${String(e)}`))
    return problems
  }
  if (ignored.length) {
    problems.push(
      new Error(
        `${where}: uses keyword(s) the validator IGNORES, so the schema would ` +
          `not enforce what it appears to: ${ignored.join(', ')}`
      )
    )
  }
  return problems
}

/** Is this a well-formed Visibility? Returns problems, empty when fine. */
export function validateVisibility(v: unknown, where: string): Error[] {
  if (v === null || typeof v !== 'object') {
    return [new Error(`${where}: visibility must be an object`)]
  }
  const node = v as Record<string, unknown>
  if ('schema' in node) return []
  if ('all' in node || 'any' in node) {
    const list = (node.all ?? node.any) as unknown
    if (!Array.isArray(list) || list.length === 0) {
      return [new Error(`${where}: all/any must be a non-empty array`)]
    }
    return list.flatMap((child, i) =>
      validateVisibility(child, `${where}[${i}]`)
    )
  }
  if (typeof node.field !== 'string' || !node.field) {
    return [new Error(`${where}: missing "field"`)]
  }
  if (!VISIBILITY_OPS.includes(node.op as string)) {
    return [
      new Error(
        `${where}: unknown op "${String(node.op)}" — expected one of ${VISIBILITY_OPS.join(', ')}`
      ),
    ]
  }
  return []
}

export interface ValidateManifestOptions {
  /** tosijs-schema's `unenforcedKeywords`, injected to keep this pure. */
  unenforced: (schema: JsonSchema) => string[]
  /** Roles the host actually defines. A manifest may not invent one. */
  knownRoles: readonly string[]
}

/**
 * Validate a manifest. Returns EVERY problem, not just the first — an installer
 * that reports one error per attempt turns a ten-mistake manifest into ten
 * round trips.
 */
export function validateManifest(
  input: unknown,
  { unenforced, knownRoles }: ValidateManifestOptions
): Error[] {
  const problems: Error[] = []
  const fail = (m: string) => problems.push(new Error(m))

  if (input === null || typeof input !== 'object') {
    return [new Error('manifest must be an object')]
  }
  const m = input as Record<string, unknown>

  // Format version FIRST: an unknown version means every check below is being
  // applied to a shape it was not written for, so refuse rather than guess.
  if (m.manifest !== 1) {
    return [
      new Error(
        `unsupported manifest version ${JSON.stringify(m.manifest)} — this host understands 1`
      ),
    ]
  }

  if (typeof m.name !== 'string' || !NAMESPACE_PATTERN.test(m.name)) {
    fail(`"name" must be a valid namespace, got ${JSON.stringify(m.name)}`)
  }
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) {
    fail(`"version" must be semver, got ${JSON.stringify(m.version)}`)
  }

  // v1 is declarative. Refuse rather than ignore — see the header.
  if ('functions' in m && m.functions !== undefined) {
    fail(
      'this host installs DECLARATIVE manifests only; "functions" is not ' +
        'supported and is refused rather than ignored (stored ajs is install v2)'
    )
  }

  if (Array.isArray(m.usesRoles)) {
    for (const role of m.usesRoles) {
      if (!knownRoles.includes(role as string)) {
        fail(
          `usesRoles: "${String(role)}" is not a role this host defines — ` +
            'installs declare the roles they need, they never create principals'
        )
      }
    }
  }

  const collections = m.collections
  if (collections === null || typeof collections !== 'object') {
    fail('"collections" must be an object')
    return problems
  }

  const namespace = typeof m.name === 'string' ? m.name : ''
  for (const [logical, raw] of Object.entries(
    collections as Record<string, unknown>
  )) {
    const where = `collections["${logical}"]`

    // The gate that keeps a manifest out of the platform's and other
    // libraries' collections.
    const refusal = namespace ? refuseDeclaration(namespace, logical) : null
    if (refusal) fail(`${where}: ${refusal.message}`)

    if (raw === null || typeof raw !== 'object') {
      fail(`${where}: must be an object`)
      continue
    }
    const c = raw as Record<string, unknown>

    if (c.schema === null || typeof c.schema !== 'object') {
      fail(`${where}.schema: required`)
    } else {
      problems.push(
        ...assertSafeSchema(c.schema as JsonSchema, `${where}.schema`, unenforced)
      )
    }

    if (c.unique !== undefined) {
      if (!Array.isArray(c.unique) || c.unique.some((f) => typeof f !== 'string')) {
        fail(`${where}.unique: must be an array of field names`)
      } else if (c.unique.length > 1) {
        // A multi-field unique constraint needs a COMPOSITE INDEX, which is a
        // deploy artifact — and "install without deploying" is the whole point.
        // Refused in v1 rather than silently not enforced.
        fail(
          `${where}.unique: v1 supports one field per collection; ` +
            'a composite constraint needs an index, which is a deployment'
        )
      }
    }

    if (c.envelope !== undefined) {
      const env = c.envelope as Record<string, unknown>
      if (env === null || typeof env !== 'object') {
        fail(`${where}.envelope: must be an object`)
      } else {
        for (const flag of ['seq', 'requireAttribution'] as const) {
          if (env[flag] !== undefined && typeof env[flag] !== 'boolean') {
            fail(`${where}.envelope.${flag}: must be true or false`)
          }
        }
      }
    }

    if (c.derive !== undefined) {
      if (!Array.isArray(c.derive)) {
        fail(`${where}.derive: must be an array`)
      } else {
        c.derive.forEach((op, i) => {
          const kind = (op as Record<string, unknown>)?.op
          if (!DERIVE_OPS.includes(kind as string)) {
            fail(
              `${where}.derive[${i}]: unknown op ${JSON.stringify(kind)} — ` +
                `expected one of ${DERIVE_OPS.join(', ')}`
            )
          }
        })
      }
    }

    if (!Array.isArray(c.access)) {
      fail(`${where}.access: must be an ARRAY of rules (order must not matter)`)
      continue
    }
    c.access.forEach((rule, i) => {
      const r = rule as Record<string, unknown>
      const rw = `${where}.access[${i}]`
      if (typeof r?.role !== 'string' || !knownRoles.includes(r.role)) {
        fail(`${rw}.role: "${String(r?.role)}" is not a role this host defines`)
      }
      for (const method of ['read', 'list', 'write'] as const) {
        const grant = r?.[method]
        if (grant === undefined || grant === 'ALL') continue
        if (grant === null || typeof grant !== 'object') {
          fail(`${rw}.${method}: must be "ALL" or an object`)
          continue
        }
        const g = grant as Record<string, unknown>
        if (g.visible !== undefined) {
          problems.push(...validateVisibility(g.visible, `${rw}.${method}.visible`))
        }
        for (const [key, label] of [
          ['project', 'project'],
          ['accept', 'accept'],
        ] as const) {
          if (g[key] !== undefined) {
            problems.push(
              ...assertSafeSchema(
                g[key] as JsonSchema,
                `${rw}.${method}.${label}`,
                unenforced
              )
            )
          }
        }
        if (method === 'write' && g.accept === undefined) {
          fail(`${rw}.write: a restricted write must declare "accept"`)
        }
      }
    })
  }

  // --- capabilities ---------------------------------------------------------
  //
  // Previously UNVALIDATED: a manifest could request any kind with any
  // arguments and it passed. That is tolerable only while nothing consults the
  // grant; it stops being tolerable the moment anything does.
  if (m.capabilities !== undefined) {
    if (Array.isArray(m.capabilities)) {
      fail(
        '"capabilities" must be an object keyed by name, not an array — ' +
          'an array carries no identity, so a reorder looks like a change and ' +
          'a rename looks like none'
      )
    } else if (m.capabilities === null || typeof m.capabilities !== 'object') {
      fail('"capabilities" must be an object')
    } else {
      for (const [logical, raw] of Object.entries(
        m.capabilities as Record<string, unknown>
      )) {
        const where = `capabilities["${logical}"]`

        // Namespaced like a collection, and for the same reason: two libraries
        // that both want `notify` must not collide.
        const refusal = namespace ? refuseDeclaration(namespace, logical) : null
        if (refusal) fail(`${where}: ${refusal.message}`)

        if (raw === null || typeof raw !== 'object') {
          fail(`${where}: must be an object`)
          continue
        }
        const cap = raw as Record<string, unknown>

        if (!CAPABILITY_KINDS.includes(cap.kind as string)) {
          fail(
            `${where}.kind: ${JSON.stringify(cap.kind)} is not a capability ` +
              `this host recognises — expected one of ` +
              `${CAPABILITY_KINDS.join(', ')}`
          )
        }

        if (cap.access === undefined) continue
        if (!Array.isArray(cap.access)) {
          fail(`${where}.access: must be an ARRAY of rules`)
          continue
        }
        cap.access.forEach((rule, i) => {
          const r = rule as Record<string, unknown>
          const rw = `${where}.access[${i}]`
          if (typeof r?.role !== 'string' || !knownRoles.includes(r.role)) {
            fail(`${rw}.role: "${String(r?.role)}" is not a role this host defines`)
          }
          const use = r?.use
          if (use === undefined) {
            // Silence here would mean "declared a rule, granted nothing",
            // which reads as a grant to whoever wrote it.
            fail(`${rw}.use: required — a rule that grants nothing is a mistake`)
            return
          }
          if (use === 'ALL') return
          if (use === null || typeof use !== 'object') {
            fail(`${rw}.use: must be "ALL" or an object`)
            return
          }
          const g = use as Record<string, unknown>
          if (g.visible !== undefined) {
            problems.push(...validateVisibility(g.visible, `${rw}.use.visible`))
          }
          if (g.project !== undefined) {
            problems.push(
              ...assertSafeSchema(g.project as JsonSchema, `${rw}.use.project`, unenforced)
            )
          }
        })
      }
    }
  }

  return problems
}

/**
 * Declared capabilities whose kind this host recognises but cannot yet enforce.
 *
 * Surfaced in the install response rather than refused. They are inert — no
 * code consults the grant — so refusing them would block a library from
 * declaring its real needs ahead of the host supporting them. But the human
 * approving must not be told they are approving a live power.
 */
export function unenforcedCapabilities(manifest: Manifest): string[] {
  return Object.entries(manifest.capabilities ?? {})
    .filter(([, c]) => !ENFORCED_CAPABILITY_KINDS.includes(c.kind))
    .map(([name]) => name)
}
