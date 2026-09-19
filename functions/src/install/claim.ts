/**
 * The claim ceremony (A3, tosijs-platform#5) — pure decision logic.
 *
 * How a fresh host gets its first `configurator` without anyone holding a secret.
 *
 * ## The ceremony
 *
 *   1. the endpoint publishes a NONCE at an unauthenticated GET;
 *   2. the claimant writes that nonce into a designated document **directly in
 *      the datastore** — Firebase console, gcloud, psql;
 *   3. the claimant calls back, authenticated; the endpoint compares, mints
 *      `configurator`, rotates the nonce and clears the proof.
 *
 * ## Why this shape rather than a first-run token
 *
 * The obvious design hands the deployer a secret at first boot. That secret has
 * a leak window, a "who holds it in CI" problem, and no recovery story once it
 * is lost. This has none of those:
 *
 *   - **nothing secret is published.** The nonce is public and worthless on its
 *     own — the proof is not *knowing* it, it is being able to WRITE it where
 *     only the datastore holder can write. `firestore.rules` is deny-all, so
 *     there is no path to that document through the API for anyone.
 *   - **it is re-runnable**, so it doubles as break-glass recovery when the
 *     configurator loses their account. Rotation is what makes that safe.
 *   - **it is substrate-portable** — the same ceremony works on Postgres, where
 *     the equivalent of "console access" is a psql prompt.
 *   - it is not an invented authority. It is D3 made operational: whoever can
 *     write the datastore already outranks everything this system can enforce,
 *     so proving *that* is the strongest claim available and the only one worth
 *     bootstrapping from.
 *
 * ## On constant-time comparison
 *
 * Deliberately a plain `===`. A timing oracle leaks the nonce, and the nonce is
 * PUBLISHED — knowing it proves nothing. The secret here is write access to the
 * datastore, which no amount of timing reveals. Noted because "why isn't this
 * constant-time" is the obvious review question and the answer is structural.
 */

/** The single document the ceremony uses. NOT registered in COLLECTIONS. */
export const CLAIM_PATH = 'system:claim/current'

/** How long a published nonce stays usable. */
export const NONCE_TTL_MS = 60 * 60 * 1000

export interface ClaimState {
  /** The currently published nonce. */
  nonce?: string
  /** When it was issued (ISO). */
  issuedAt?: string
  /** What the claimant wrote in, directly, to prove datastore access. */
  proof?: string
  /** Set once a claim succeeds, for the ledger. */
  claimedBy?: string
  claimedAt?: string
}

export type ClaimRefusal =
  | 'no-nonce'
  | 'expired'
  | 'no-proof'
  | 'mismatch'
  | 'no-principal'

export type ClaimDecision =
  | { status: 'granted'; principal: string; rotate: true }
  | { status: 'refused'; reason: ClaimRefusal }

export interface ClaimInput {
  state: ClaimState | null
  /** The authenticated caller. A claim must be attributable. */
  principal: string | null
  /** Injected clock (ms). */
  now: number
  ttlMs?: number
}

/**
 * Decide a claim. Pure: no store, no clock, no crypto.
 *
 * Refusals are deliberately *specific* here and deliberately *generic* at the
 * endpoint — the caller of this function needs to know which invariant failed in
 * order to log it; the HTTP client does not, because "your proof did not match"
 * and "there is no nonce" together describe the state of the ceremony to someone
 * who should not be able to observe it.
 */
export function decideClaim({
  state,
  principal,
  now,
  ttlMs = NONCE_TTL_MS,
}: ClaimInput): ClaimDecision {
  // Attribution first: an unauthenticated claim has nobody to grant TO, and the
  // ledger entry would be meaningless.
  if (!principal) return { status: 'refused', reason: 'no-principal' }

  if (!state?.nonce) return { status: 'refused', reason: 'no-nonce' }

  const issued = state.issuedAt ? Date.parse(state.issuedAt) : NaN
  // An unparseable or absent issuedAt is treated as expired rather than
  // ignored: a nonce whose age cannot be established is not a fresh one.
  if (!Number.isFinite(issued) || now - issued > ttlMs) {
    return { status: 'refused', reason: 'expired' }
  }

  if (!state.proof) return { status: 'refused', reason: 'no-proof' }
  if (state.proof !== state.nonce) {
    return { status: 'refused', reason: 'mismatch' }
  }

  // `rotate` is not advice — the caller MUST replace the nonce and clear the
  // proof in the same write that records the grant. Without rotation the proof
  // sits in the datastore and the next authenticated caller claims for free,
  // which converts a one-time ceremony into a standing back door.
  return { status: 'granted', principal, rotate: true }
}

/**
 * The state to store after a granted claim.
 *
 * Kept next to `decideClaim` so the rotation it demands cannot drift away from
 * it. The old nonce is not retained: there is no use for it and keeping it
 * invites a replay.
 */
export function rotatedState(
  _previous: ClaimState,
  nextNonce: string,
  principal: string,
  nowIso: string
): ClaimState {
  return {
    nonce: nextNonce,
    issuedAt: nowIso,
    // proof deliberately absent — cleared, not blanked, so a re-claim needs a
    // fresh write rather than an empty-string match.
    claimedBy: principal,
    claimedAt: nowIso,
  }
}

/**
 * Was a claim ever completed on this host?
 *
 * Used to decide whether `/claim` is a bootstrap or a break-glass re-run — the
 * mechanics are identical, but the second should be conspicuous in the ledger.
 */
export const hasBeenClaimed = (state: ClaimState | null): boolean =>
  Boolean(state?.claimedBy)
