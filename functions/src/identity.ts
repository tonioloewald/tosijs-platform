/**
 * The identity port (SOVEREIGN-PLAN.md Phase 1, "Auth").
 *
 * Who a bearer ID token says the caller is, plus the two extras the platform
 * uses today: role claims mirrored onto the identity (for Storage rules) and
 * the web config the sign-in pages need. On Firebase the provider is Firebase
 * Auth (`adapters/firebase/identity.ts`, installed in index.ts); a sovereign
 * host plugs in its own (passkeys, an OIDC issuer).
 *
 * Until a provider is installed, every token fails verification, so callers
 * are anonymous: an unconfigured host fails CLOSED, never open.
 */

/** A verified token's claims. `uid` is the stable principal id. */
export interface VerifiedIdentity {
  uid: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
  [claim: string]: unknown
}

export interface IdentityProvider {
  /**
   * Verify an ID token, refusing revoked sessions. REJECTS on any failure; a
   * revocation rejects with `code: 'auth/id-token-revoked'`.
   */
  verifyIdToken(idToken: string): Promise<VerifiedIdentity>
  /** The custom claims stored on the identity (`{}` if none). */
  customClaims(uid: string): Promise<Record<string, unknown>>
  setCustomClaims(uid: string, claims: Record<string, unknown>): Promise<void>
  /** The client-side sign-in config the consent pages embed. */
  webConfig(): Promise<Record<string, unknown>>
}

const unconfigured = (): Promise<never> => Promise.reject(new Error('no identity provider is installed'))

let provider: IdentityProvider = {
  verifyIdToken: unconfigured,
  customClaims: unconfigured,
  setCustomClaims: unconfigured,
  webConfig: unconfigured,
}

export const setIdentityProvider = (p: IdentityProvider): void => {
  provider = p
}

/** The installed provider, read at call time (it is installed after modules load). */
export const identity = (): IdentityProvider => provider
