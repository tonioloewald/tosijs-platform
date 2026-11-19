/**
 * Guest identities: the identity port (identity.ts) for a host that signs its
 * own short-lived tokens and keeps no accounts. The first rooms host uses it
 * (D26, v1): its first players are mostly synthetic agents, which need a token
 * they can ask for, not a sign-in page.
 *
 * Anyone may ask for a guest, so a guest token proves only that its holder is
 * the same guest as before. That is enough for relay-only rooms, where the
 * room code is the gate, and for nothing that grants a role: a guest has no
 * custom claims and can be given none.
 *
 * A token is `guest.` + base64url(JSON { uid, name, exp }) + `.` + base64url(
 * HMAC-SHA256 of the middle part, keyed by the host's secret). It is a
 * bearer token: whoever holds it is that guest until `exp`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import type { IdentityProvider, VerifiedIdentity } from '../../identity'

export const GUEST_TOKEN_PREFIX = 'guest.'
/** As long as a room lives (rooms.ts ROOM_LIFETIME_MS). */
export const GUEST_LIFETIME_MS = 24 * 3600 * 1000
/** Letters, digits, spaces and a little punctuation; 1 to 32 characters. */
export const GUEST_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.'-]{0,31}$/u

export interface Guest {
  uid: string
  name: string
  token: string
  expires: string
}

export interface GuestIdentities {
  provider: IdentityProvider
  /** A new guest, named `name` or a default; an Error if the name is not allowed. */
  issue(name?: unknown): Guest | Error
}

export function guestIdentities(secret: Uint8Array, now: () => number = Date.now): GuestIdentities {
  if (secret.length < 32) throw new Error('a guest secret needs at least 32 bytes')
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url')

  const issue = (name?: unknown): Guest | Error => {
    const uid = `guest-${randomBytes(12).toString('base64url')}`
    if (name !== undefined && (typeof name !== 'string' || !GUEST_NAME.test(name))) {
      return new Error("a guest name is 1 to 32 letters, digits, spaces or _ . ' -, starting with a letter or digit")
    }
    const exp = now() + GUEST_LIFETIME_MS
    const claims = { uid, name: name ?? `Guest ${uid.slice(6, 10)}`, exp }
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return { uid, name: claims.name, token: `${GUEST_TOKEN_PREFIX}${payload}.${sign(payload)}`, expires: new Date(exp).toISOString() }
  }

  const provider: IdentityProvider = {
    async verifyIdToken(token) {
      if (!token.startsWith(GUEST_TOKEN_PREFIX)) throw new Error('not a guest token')
      const parts = token.slice(GUEST_TOKEN_PREFIX.length).split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed guest token')
      const [payload, mac] = parts
      const expected = Buffer.from(sign(payload))
      const given = Buffer.from(mac)
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error('guest token signature does not verify')
      // Signed by this host, so the claims are its own; checked anyway.
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
      if (typeof claims.uid !== 'string' || typeof claims.exp !== 'number') throw new Error('malformed guest token')
      if (claims.exp <= now()) throw new Error('guest token expired')
      return { uid: claims.uid, name: String(claims.name), guest: true } as VerifiedIdentity
    },
    customClaims: async () => ({}),
    setCustomClaims: () => Promise.reject(new Error('a guest carries no claims')),
    webConfig: async () => ({ guests: true }),
  }

  return { provider, issue }
}
