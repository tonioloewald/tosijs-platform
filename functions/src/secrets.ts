/**
 * The secrets port (SOVEREIGN-PLAN.md Phase 1): a named secret's value, read
 * at request time, `''` when unset.
 *
 * Every host delivers secrets as environment variables: Cloud Functions mounts
 * the secrets an endpoint declares (adapters/firebase/http.ts) into its
 * environment, which is all firebase-functions' `defineSecret(name).value()`
 * reads (`process.env[name] || ''`); a single-box host sets them in its env.
 */
export const secret = (name: string): string => process.env[name] || ''
