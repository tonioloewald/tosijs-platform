/**
 * Dev identities: the identity port (identity.ts) for `bun run serve:local`
 * ONLY. Like the Auth emulator's tokens, they are unsigned, so anyone who can
 * reach the server can be anyone. The Bun server installs this only when it
 * listens on a loopback address (adapters/bun/server.ts refuses otherwise).
 *
 * A token is `dev.` + base64url(JSON claims), with at least `sub` (or `uid`):
 *
 *   devToken({ sub: 'alice', email: 'alice@example.invalid' })
 *
 * Custom claims live in memory: they only mirror roles for Storage rules,
 * which a local host does not have.
 */
import type { IdentityProvider, VerifiedIdentity } from '../../identity'

export const DEV_TOKEN_PREFIX = 'dev.'

/** A dev token for these claims. */
export const devToken = (claims: { sub?: string; uid?: string; [claim: string]: unknown }): string =>
  DEV_TOKEN_PREFIX + Buffer.from(JSON.stringify(claims)).toString('base64url')

export function devIdentities(): IdentityProvider {
  const customClaims = new Map<string, Record<string, unknown>>()
  return {
    async verifyIdToken(idToken) {
      if (!idToken.startsWith(DEV_TOKEN_PREFIX)) throw new Error('not a dev identity token')
      let claims: Record<string, unknown>
      try {
        claims = JSON.parse(Buffer.from(idToken.slice(DEV_TOKEN_PREFIX.length), 'base64url').toString('utf8'))
      } catch {
        throw new Error('malformed dev identity token')
      }
      const uid = claims && typeof claims === 'object' ? claims.uid ?? claims.sub : undefined
      if (typeof uid !== 'string' || !uid) {
        throw new Error('a dev identity token needs a sub')
      }
      return { ...claims, ...customClaims.get(uid), uid } as VerifiedIdentity
    },
    customClaims: async (uid) => ({ ...customClaims.get(uid) }),
    setCustomClaims: async (uid, claims) => {
      customClaims.set(uid, { ...claims })
    },
    webConfig: async () => ({ projectId: 'local', devIdentities: true }),
  }
}
