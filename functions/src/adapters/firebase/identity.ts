/**
 * The identity port (`identity.ts`) on Firebase Auth. Moved out of
 * utilities.ts and auth/authorize-endpoint.ts unchanged.
 */
import { firebaseAdmin } from './app'
import type { IdentityProvider, VerifiedIdentity } from '../../identity'

let cachedConfig: Record<string, unknown> | null = null

export const firebaseIdentity: IdentityProvider = {
  // `checkRevoked` (the `true`) costs one extra Auth lookup, and buys the
  // difference between "signed out everywhere" meaning it and meaning it in an
  // hour (see verifyFirebaseIdToken in utilities.ts).
  verifyIdToken: async (idToken) => (await firebaseAdmin().auth().verifyIdToken(idToken, true)) as VerifiedIdentity,

  customClaims: async (uid) => (await firebaseAdmin().auth().getUser(uid)).customClaims ?? {},

  setCustomClaims: (uid, claims) => firebaseAdmin().auth().setCustomUserClaims(uid, claims),

  /** The Firebase web config for this project, from the Firebase Management API. */
  async webConfig() {
    if (cachedConfig) return cachedConfig
    const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? ''
    const credential = firebaseAdmin().app().options.credential
    const accessToken = await credential?.getAccessToken()
    const res = await fetch(`https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps/-/config`, {
      headers: { Authorization: `Bearer ${accessToken?.access_token}` },
    })
    if (!res.ok) {
      throw new Error(`could not read the web config: ${res.status}`)
    }
    cachedConfig = (await res.json()) as Record<string, unknown>
    return cachedConfig
  },
}
