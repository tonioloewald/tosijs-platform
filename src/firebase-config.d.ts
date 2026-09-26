/**
 * The SHAPE of `src/firebase-config.ts`, which is gitignored and per project
 * (`bun run use <alias>` copies `firebase-config.<alias>.ts` into place).
 *
 * Committed so the client typechecks on a machine with no project selected —
 * CI, in particular: the publish workflow's release-doctor runs `typecheck`, and
 * without this it failed with "Cannot find module './firebase-config'". Where
 * the real `.ts` exists TypeScript resolves it first, so this never shadows a
 * real config. Keep it in step with `firebase-config.example.ts`.
 */
export declare const PRODUCTION_BASE: string

export declare const config: {
  authDomain: string
  projectId: string
  storageBucket: string
  apiKey: string
  messagingSenderId: string
  appId: string
  measurementId: string
}
