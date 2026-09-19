/**
 * Browser-loop authorization for CLIs and agents (B2, #6) — pure decisions.
 *
 * How a command line with no credentials gets its first token, without anyone
 * pasting a secret.
 *
 *   1. the CLI generates a random VERIFIER, keeps it, and sends only its
 *      sha256 (the challenge) when it starts a request;
 *   2. a human opens the consent page, signs in with Google, reads the exact
 *      caveats the CLI asked for, and approves;
 *   3. the CLI exchanges `requestId + verifier` for the token.
 *
 * ## This is PKCE's shape, not OAuth
 *
 * Google is the identity provider; we are not one, and becoming one would be a
 * large amount of work for nothing that is needed. What is borrowed is the part
 * that carries the security: a code that is useless without a secret the
 * browser never saw.
 *
 * ## The browser never receives the token
 *
 * Approval records WHO approved — it does not mint. Minting happens at the
 * exchange, from the approver's LIVE roles, and the secret goes straight to the
 * CLI. Two consequences:
 *
 *   - the token secret is still never stored anywhere, which is the property
 *     that makes the `token` collection safe to hold at all;
 *   - a token minted at approval and collected later could outlive a
 *     revocation in between. Minting at exchange cannot.
 *
 * ## Why `loopback` is the default and `poll` carries a warning
 *
 * Both modes end in the same exchange. They differ only in how the CLI learns
 * that approval happened, and that difference is a real security boundary:
 *
 *   - **loopback** — the consent page redirects to `127.0.0.1:<port>` on the
 *     machine that started the flow. An attacker who phishes somebody into
 *     approving cannot receive that redirect, because it never leaves the
 *     victim's machine. This is why `gcloud auth login` works this way.
 *   - **poll** — the CLI asks repeatedly. Necessary for a cloud sandbox or an
 *     SSH session, where there is no browser and no reachable local port. But
 *     it reopens the classic device-flow phishing attack: send somebody a
 *     consent URL, have them approve, and collect a token carrying THEIR
 *     authority. The caveats are chosen by whoever started the flow, so the
 *     attacker picks them.
 *
 * No protocol fixes that — a user code typed by hand does not, and neither does
 * a warning. What reduces it: a short TTL, the caveats shown in full, and the
 * consent page saying plainly that approving hands the requester this access.
 * `poll` is therefore opt-in, never the default.
 */

import { createHash, randomBytes } from 'crypto'

/** Unregistered, so deny-default makes it unreachable through /doc. */
export const AUTHORIZE_COLLECTION = 'system:authorize'

/**
 * Short, because an outstanding request is an outstanding invitation to
 * approve something. Ten minutes is comfortably longer than a sign-in and far
 * shorter than a coffee break.
 */
export const REQUEST_TTL_MS = 10 * 60 * 1000

/** How often a polling CLI should ask. Advertised so clients do not guess. */
export const POLL_INTERVAL_MS = 2000

export type AuthorizeMode = 'loopback' | 'poll'

export interface AuthorizeRequest {
  _id?: string
  label: string
  /** Pinned at START. See `decideApprove`. */
  caveats: Record<string, unknown>
  ttlMs: number
  /** sha256(verifier), base64url. The verifier itself never arrives here. */
  codeChallenge: string
  mode: AuthorizeMode
  /** Loopback only: where the consent page sends the browser afterwards. */
  redirectPort?: number
  status: 'pending' | 'approved' | 'denied'
  expiresAt: string
  createdAt: string
  approvedBy?: string
  approvedAt?: string
  /** Set once exchanged. A request is good for exactly one token. */
  usedAt?: string
}

const B64URL = /^[A-Za-z0-9_-]{32,128}$/

export const sha256Base64Url = (value: string): string =>
  createHash('sha256').update(value).digest('base64url')

/** A verifier for a CLI to keep. 256 bits. */
export const newVerifier = (): string => randomBytes(32).toString('base64url')

export type StartDecision =
  | { status: 'started'; record: Omit<AuthorizeRequest, '_id'> }
  | { status: 'refused'; problems: string[] }

export interface StartInput {
  label: unknown
  caveats: unknown
  codeChallenge: unknown
  mode: unknown
  redirectPort?: unknown
  ttlMs?: unknown
  nowIso: string
}

export function decideStart(input: StartInput): StartDecision {
  const problems: string[] = []
  const fail = (m: string) => problems.push(m)

  if (typeof input.label !== 'string' || input.label.trim().length < 3) {
    fail('"label" is required — it names the agent context and is the provenance')
  }
  if (typeof input.codeChallenge !== 'string' || !B64URL.test(input.codeChallenge)) {
    fail('"codeChallenge" must be base64url sha256 of a verifier')
  }
  if (input.mode !== 'loopback' && input.mode !== 'poll') {
    fail('"mode" must be "loopback" or "poll"')
  }
  if (input.mode === 'loopback') {
    const port = Number(input.redirectPort)
    // Unprivileged ports only: a consent page that can be made to redirect to
    // a privileged port is a small SSRF primitive aimed at the user's own
    // machine, and no CLI needs one.
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      fail('"redirectPort" must be an unprivileged port (1024-65535)')
    }
  }

  const caveats = input.caveats as Record<string, unknown> | null
  if (caveats === null || typeof caveats !== 'object') {
    fail('"caveats" must be an object')
  } else if (
    !Array.isArray(caveats.roles) ||
    caveats.roles.length === 0 ||
    caveats.roles.some((r) => typeof r !== 'string')
  ) {
    // Only a shape check here — there is no principal yet, so "may you
    // delegate this" is unanswerable. `decideMint` answers it at exchange,
    // against the approver's live roles.
    fail('"caveats.roles" is required — a token must say what it is for')
  }

  const ttlMs =
    input.ttlMs === undefined ? REQUEST_TTL_MS : Number(input.ttlMs)
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > REQUEST_TTL_MS) {
    fail(`"ttlMs" must be a positive number no greater than ${REQUEST_TTL_MS}`)
  }

  if (problems.length) return { status: 'refused', problems }

  return {
    status: 'started',
    record: {
      label: (input.label as string).trim(),
      caveats: caveats as Record<string, unknown>,
      // Carried through so the token's own lifetime is decided by the CLI at
      // start and approved along with everything else.
      ttlMs: Number(
        (caveats as Record<string, unknown>).ttlMs ?? 30 * 24 * 60 * 60 * 1000
      ),
      codeChallenge: input.codeChallenge as string,
      mode: input.mode as AuthorizeMode,
      ...(input.mode === 'loopback'
        ? { redirectPort: Number(input.redirectPort) }
        : {}),
      status: 'pending',
      expiresAt: new Date(Date.parse(input.nowIso) + ttlMs).toJSON(),
      createdAt: input.nowIso,
    },
  }
}

export type ApproveDecision =
  | { status: 'approved'; patch: Partial<AuthorizeRequest> }
  | { status: 'refused'; reason: 'unknown' | 'expired' | 'already-decided' }

/**
 * Record an approval. Deliberately does NOT mint.
 *
 * The caveats are whatever was pinned at start, and are never re-read from the
 * approving request — the human approved a list they were shown, and letting
 * the approval carry its own caveats would let a CLI display "read-only" and
 * mint `admin`. Same principle as `approving` pinning capability content in
 * the install flow: approve the content, not a label.
 */
export function decideApprove(
  record: AuthorizeRequest | null,
  principalUid: string,
  nowMs: number,
  nowIso: string
): ApproveDecision {
  if (!record) return { status: 'refused', reason: 'unknown' }
  if (record.status !== 'pending') {
    return { status: 'refused', reason: 'already-decided' }
  }
  const expires = Date.parse(record.expiresAt ?? '')
  if (!Number.isFinite(expires) || nowMs >= expires) {
    return { status: 'refused', reason: 'expired' }
  }
  return {
    status: 'approved',
    patch: { status: 'approved', approvedBy: principalUid, approvedAt: nowIso },
  }
}

export type ExchangeDecision =
  | { status: 'pending' }
  | { status: 'ready'; principalUid: string; label: string; caveats: Record<string, unknown>; ttlMs: number }
  | {
      status: 'refused'
      reason: 'unknown' | 'expired' | 'denied' | 'used' | 'bad-verifier'
    }

/**
 * Decide an exchange.
 *
 * The verifier is checked BEFORE the status is revealed, so a caller without
 * it cannot learn whether a request exists or has been approved — polling is
 * a capability the CLI holds, not an open query.
 */
export function decideExchange(
  record: AuthorizeRequest | null,
  verifier: string,
  nowMs: number
): ExchangeDecision {
  if (!record) return { status: 'refused', reason: 'unknown' }

  if (
    typeof verifier !== 'string' ||
    sha256Base64Url(verifier) !== record.codeChallenge
  ) {
    return { status: 'refused', reason: 'bad-verifier' }
  }

  // Single use, checked before expiry so a replay reads as a replay rather
  // than as a stale request.
  if (record.usedAt) return { status: 'refused', reason: 'used' }

  const expires = Date.parse(record.expiresAt ?? '')
  if (!Number.isFinite(expires) || nowMs >= expires) {
    return { status: 'refused', reason: 'expired' }
  }

  if (record.status === 'denied') return { status: 'refused', reason: 'denied' }
  if (record.status === 'pending') return { status: 'pending' }

  return {
    status: 'ready',
    principalUid: record.approvedBy as string,
    label: record.label,
    caveats: record.caveats,
    ttlMs: record.ttlMs,
  }
}

/**
 * Where the consent page sends the browser when a loopback flow completes.
 *
 * Hardcoded to `127.0.0.1` — never a caller-supplied host, and never
 * `localhost`, which resolves through the DNS the machine happens to be using
 * and has been made to point elsewhere. Only the port is variable, and only
 * within the unprivileged range.
 */
export function loopbackRedirect(port: number, requestId: string): string {
  return `http://127.0.0.1:${port}/?request=${encodeURIComponent(requestId)}`
}
