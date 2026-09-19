/**
 * Scoped capability tokens (B2, tosijs-platform#6) — pure decision logic.
 *
 * An agent needs to authenticate from a laptop or a cloud sandbox without
 * holding the human's credentials. The obvious shape — issue a long-lived
 * credential carrying a set of roles — is a second, parallel authority system,
 * and the two drift: revoking the human leaves the agent working.
 *
 * ## Tokens ATTENUATE, they never grant
 *
 * A token is `(principal, caveats)`. Effective authority is recomputed on every
 * request as
 *
 *     rolesOf(principal)  ∩  caveats.roles  −  NEVER_BY_TOKEN
 *
 * where `rolesOf` is the same live read `getUserRoles` already does. Three
 * consequences, and they are the whole design:
 *
 *   - a token can never hold authority its principal does not hold **right
 *     now**. Not "at mint time" — now.
 *   - revoking the human revokes every token they minted, instantly, with no
 *     revocation list to maintain and nothing to remember to do.
 *   - the token records a subset, so reading the token collection tells you
 *     what a credential could do at most, never what it can do — the live
 *     answer is always narrower or equal.
 *
 * ## The token IS the provenance (#6)
 *
 * A token names its agent context — machine × repo — and that context travels
 * with every write it makes. Attribution is by credential rather than by
 * convention, so "which agent wrote this" is answerable from the record instead
 * of from a field the writer chose to populate honestly.
 *
 * ## What a token may never carry
 *
 * `owner`, `configurator` and `developer` are refused in caveats. Each is an
 * authority over *the system itself* rather than over documents:
 *
 *   - `owner` writes `role`, i.e. rewrites the input to everyone's
 *     authorization (D4);
 *   - `configurator` installs libraries — arbitrary collections, schemas and
 *     access rules;
 *   - `developer` writes `module`, which `/esm` serves as executable
 *     JavaScript. That is arbitrary code execution, and it is the tail of the
 *     escalation chain D4 exists to sever.
 *
 * All three are acts that should require a human at an interactive session,
 * not a bearer secret sitting in a file on a build machine. Refusing them is
 * the conservative direction: allowing one later is additive, and taking one
 * away later breaks whoever relied on it.
 *
 * ## A token may not mint another token
 *
 * Minting from a token would produce credentials whose chain nobody enumerated,
 * and the value of "enumerable and revocable as data" (#6) is exactly that the
 * list is complete. Attenuation would still hold — the chain can only narrow —
 * but a compromised agent could spray siblings faster than anyone revokes them.
 */

import { createHash, randomBytes } from 'crypto'

import { ROLES, type RoleName } from '../collections/roles'

/** The token's own secret is NEVER stored. See `TokenRecord.hash`. */
export const TOKEN_PREFIX = 'tsp_'

/** Authority a token may never carry, however privileged its principal. */
export const NEVER_BY_TOKEN: readonly string[] = [
  ROLES.owner,
  ROLES.configurator,
  ROLES.developer,
]

/**
 * Methods a token may use when it does not say. DELETE is excluded.
 *
 * #6 asks for "read all; write owned/subscribed; no delete/admin", and this is
 * the half of that a default can express. A token that genuinely needs to
 * delete says so at mint time, which makes the destructive credential the
 * deliberate one rather than the accidental one.
 */
export const DEFAULT_METHODS: readonly string[] = [
  'GET',
  'LIST',
  'POST',
  'PUT',
  'PATCH',
]

export const ALL_METHODS: readonly string[] = [...DEFAULT_METHODS, 'DELETE']

/** Longest life a token may be minted with. */
export const MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000

export interface Caveats {
  /** Roles this token may exercise. Required — see `decideMint`. */
  roles: string[]
  /** Methods it may use. Absent means DEFAULT_METHODS. */
  methods?: string[]
  /** Logical collections it may touch. Absent means all of them. */
  collections?: string[]
}

export interface TokenRecord {
  _id?: string
  /**
   * sha256 of the secret. The secret itself is shown ONCE, at mint, and never
   * stored — so a read of the whole `token` collection yields no credential.
   * Lookup is by hash, which is why the hash is the queryable field.
   */
  hash: string
  /** The uid whose authority this attenuates. */
  principalUid: string
  /** Agent context: machine × repo. Travels with every write. */
  label: string
  caveats: Caveats
  expiresAt: string
  createdAt: string
  createdBy: string
  revokedAt?: string
}

export type MintDecision =
  | { status: 'minted'; record: Omit<TokenRecord, 'hash' | '_id'> }
  | { status: 'refused'; problems: string[] }

export interface MintInput {
  /** The principal minting it, as resolved live. */
  principalUid: string
  principalRoles: readonly string[]
  /**
   * True when the CALLER authenticated with a token rather than a human
   * session. A token may not mint a token — see the header.
   */
  viaToken: boolean
  label: string
  caveats: unknown
  ttlMs: number
  nowIso: string
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')

export function decideMint(input: MintInput): MintDecision {
  const problems: string[] = []
  const fail = (m: string) => problems.push(m)

  if (input.viaToken) {
    fail(
      'a token may not mint another token — the enumerable list of ' +
        'credentials is only useful if it is complete'
    )
  }
  if (!input.principalUid) fail('not authenticated')
  if (typeof input.label !== 'string' || input.label.trim().length < 3) {
    // The label is provenance, not decoration: it is how "which agent wrote
    // this" is answered later. An unlabelled token is an unattributable write.
    fail('"label" is required — it names the agent context and is the provenance')
  }

  const c = input.caveats as Record<string, unknown> | null
  if (c === null || typeof c !== 'object') {
    fail('"caveats" must be an object')
    return { status: 'refused', problems }
  }

  // Roles are REQUIRED rather than defaulted to "everything the principal has".
  // A default would make the widest token the easiest one to mint, and the
  // whole point is that narrowing is the normal case.
  if (!isStringArray(c.roles) || c.roles.length === 0) {
    fail('"caveats.roles" is required — a token must say what it is for')
  } else {
    for (const role of c.roles) {
      if (NEVER_BY_TOKEN.includes(role)) {
        fail(
          `"${role}" may never be carried by a token — it is authority over ` +
            'the system itself, and needs a human at an interactive session'
        )
      } else if (!input.principalRoles.includes(role)) {
        // Attenuation: you cannot delegate what you do not hold. Checked at
        // mint for a clear error; enforced again at every request, which is
        // the check that actually matters.
        fail(`you do not hold "${role}", so you cannot delegate it`)
      }
    }
  }

  if (c.methods !== undefined) {
    if (!isStringArray(c.methods) || c.methods.length === 0) {
      fail('"caveats.methods" must be a non-empty array')
    } else {
      for (const method of c.methods) {
        if (!ALL_METHODS.includes(method)) {
          fail(`"${method}" is not a method — expected ${ALL_METHODS.join(', ')}`)
        }
      }
    }
  }

  if (c.collections !== undefined && !isStringArray(c.collections)) {
    fail('"caveats.collections" must be an array of collection names')
  }

  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    fail('"ttlMs" must be a positive number')
  } else if (input.ttlMs > MAX_TTL_MS) {
    fail(`"ttlMs" exceeds the maximum of ${MAX_TTL_MS}ms (90 days)`)
  }

  if (problems.length) return { status: 'refused', problems }

  return {
    status: 'minted',
    record: {
      principalUid: input.principalUid,
      label: input.label.trim(),
      caveats: {
        roles: c.roles as string[],
        methods: (c.methods as string[]) ?? [...DEFAULT_METHODS],
        ...(c.collections ? { collections: c.collections as string[] } : {}),
      },
      expiresAt: new Date(Date.parse(input.nowIso) + input.ttlMs).toJSON(),
      createdAt: input.nowIso,
      createdBy: input.principalUid,
    },
  }
}

export type TokenRefusal =
  | 'unknown'
  | 'revoked'
  | 'expired'
  | 'principal-has-nothing'

export type TokenAuthority =
  | {
      status: 'ok'
      roles: RoleName[]
      methods: readonly string[]
      collections?: string[]
      tokenId: string
      label: string
    }
  | { status: 'refused'; reason: TokenRefusal }

/**
 * What a token can do RIGHT NOW.
 *
 * `principalRoles` is read live on every request — never cached on the token,
 * never trusted from mint time. That single choice is what makes revoking a
 * human revoke their agents.
 */
export function tokenAuthority(
  record: TokenRecord | null,
  principalRoles: readonly string[],
  nowMs: number
): TokenAuthority {
  if (!record) return { status: 'refused', reason: 'unknown' }
  if (record.revokedAt) return { status: 'refused', reason: 'revoked' }

  const expires = Date.parse(record.expiresAt ?? '')
  // An unparseable or absent expiry is treated as EXPIRED, not as forever. A
  // credential whose lifetime cannot be established is not a live one.
  if (!Number.isFinite(expires) || nowMs >= expires) {
    return { status: 'refused', reason: 'expired' }
  }

  const held = new Set(principalRoles)
  const roles = (record.caveats?.roles ?? []).filter(
    (role) => held.has(role) && !NEVER_BY_TOKEN.includes(role)
  )
  if (!roles.length) {
    // The principal lost the roles this token attenuated. Refused rather than
    // downgraded to anonymous, so the log says what happened.
    return { status: 'refused', reason: 'principal-has-nothing' }
  }

  return {
    status: 'ok',
    roles: roles as RoleName[],
    methods: record.caveats?.methods ?? DEFAULT_METHODS,
    ...(record.caveats?.collections
      ? { collections: record.caveats.collections }
      : {}),
    tokenId: record._id ?? '',
    label: record.label,
  }
}

export { caveatsAllow } from './caveats'

/**
 * The stored lookup key for a secret.
 *
 * sha256 and not a password KDF on purpose: a token is 256 bits of CSPRNG
 * output, not a human-chosen password, so there is no dictionary to slow down
 * and the cost of bcrypt/scrypt would be paid on every authenticated request
 * for no gain. What matters is that the secret is never stored, so a read of
 * the whole collection yields nothing usable.
 */
export function hashToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** A fresh secret. 256 bits, URL-safe, prefixed so it is recognisable. */
export function newTokenSecret(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url')
}
