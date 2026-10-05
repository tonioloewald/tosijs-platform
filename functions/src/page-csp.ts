/**
 * The Content-Security-Policy for the pages the platform serves itself: the
 * /authorize consent page, the /claim page and the /install approval page.
 * Self-contained pages whose only external scripts are the Firebase auth SDK
 * (gstatic) and the Google API loader it pulls in for popup sign-in
 * (apis.google.com; without it sign-in fails with `auth/internal-error`).
 *
 * These pages are reached through HOSTING (the site's own domain), because
 * Google sign-in only works from a host's authorized domains and a function's
 * `…cloudfunctions.net` address is not one (found 2026-10-05: sign-in failed
 * on the function URL). Hosting REPLACES a function's CSP with its site-wide
 * one, which would block the SDK, so firebase.json carries a header rule for
 * these paths with this exact value (scripts/storage-rules.test.ts checks).
 */
export const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://www.gstatic.com https://apis.google.com; " +
  "connect-src https://*.googleapis.com https://*.google.com 'self'; " +
  "style-src 'unsafe-inline'; frame-src https://*.firebaseapp.com"

/** The paths served this way; each needs a Hosting rewrite to its function. */
export const PAGE_PATHS = ['authorize', 'claim', 'install'] as const
