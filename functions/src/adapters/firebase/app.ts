/**
 * The firebase-admin app. Every Firebase adapter reaches the SDK through
 * `firebaseAdmin()`, which initialises the default app on first use.
 *
 * Lazy, not at import: importing an adapter (as kernel modules under test do,
 * through firestore-store.ts) must not touch the SDK. `index.ts` calls it at
 * startup, so deployed it runs once before any request, as the old
 * module-scope `admin.initializeApp()` in utilities.ts did.
 */
import * as namespace from 'firebase-admin'

// Node (compiled CommonJS) sees the SDK's members on the namespace; bun, when
// a test imports this file, sees them only on `default`. Either way, one SDK.
const admin: typeof namespace =
  typeof namespace.initializeApp === 'function'
    ? namespace
    : (namespace as unknown as { default: typeof namespace }).default

let initialised = false

export function firebaseAdmin(): typeof admin {
  if (!initialised) {
    admin.initializeApp()
    initialised = true
  }
  return admin
}
