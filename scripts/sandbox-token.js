#!/usr/bin/env bun

/**
 * Mint a real Firebase ID token for a sandbox test principal — no browser.
 *
 * The authenticated half of the platform (role resolution, writes through
 * `/doc`, the privilege lattice) could only ever be exercised against emulators,
 * because getting a real ID token meant an interactive Google sign-in. That is
 * why `verify:sandbox` was entirely anonymous, and why three real bugs once sat
 * behind skip-guarded integration tests.
 *
 * This closes that: create (or reuse) an email/password test user via the
 * Identity Toolkit admin API, sign in with the project's public Web API key, and
 * print the ID token. Everything the live-site suite needs to test as somebody.
 *
 * ## Why email/password on the sandbox
 *
 * The platform itself is Google-sign-in-only and stays that way. Email/password
 * is enabled on the SANDBOX as a test affordance, precisely so automation does
 * not need a human at a browser. It is one of the things a throwaway project is
 * for.
 *
 * ## Refuses to touch production
 *
 * Creating test users and handing out tokens is a sandbox activity. The target
 * is resolved through `resolveSandbox()`, which refuses the `default` alias, any
 * alias resolving to the production project, and the known production id by name.
 *
 * Usage:
 *   bun scripts/sandbox-token.js                     # token for the owner test user
 *   bun scripts/sandbox-token.js --role public       # a principal with no role doc
 *   eval "$(bun scripts/sandbox-token.js --export)"  # sets SANDBOX_ID_TOKEN
 */

import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { resolveSandbox, projectRoot, parseArgs } from './sandbox-lib.js'

const { has, val } = parseArgs(process.argv)
const ALIAS = val('alias') ?? 'sandbox'
const ROLE = val('role') ?? 'owner'
const EXPORT = has('export')

const { projectId } = resolveSandbox(ALIAS)

const configPath = path.join(projectRoot, 'src', `firebase-config.${ALIAS}.ts`)
const apiKey = (
  fs.readFileSync(configPath, 'utf-8').match(/apiKey: '([^']+)'/) ?? []
)[1]
if (!apiKey) {
  console.error(`Could not read apiKey from ${configPath}`)
  process.exit(1)
}

/**
 * Deterministic per-role identities, so a test run is repeatable and the role
 * document seeded by clone-to-sandbox can match on email.
 */
/**
 * Identities are PER RUN unless pinned (#23).
 *
 * They used to be deterministic — `sandbox-installer@example.test` for
 * everyone, always. A consumer following BETA.md used the same identity to
 * claim their host that the platform's verifier used to test, so the
 * verifier's cleanup deleted the consumer's `configurator`. It could not tell
 * them apart because they were the same principal.
 *
 * `--pin` restores the fixed identity for a throwaway project where a stable
 * login is convenient.
 */
const RUN = has('pin') ? 'pin' : randomBytes(4).toString('hex')
const email = has('pin')
  ? `sandbox-${ROLE}@example.test`
  : `sandbox-${ROLE}-${RUN}@example.test`

/**
 * A RANDOM password, unless asked otherwise.
 *
 * The fixed one is in a public repository, and #17 now enables email/password
 * sign-in on every provisioned host — so a consumer following the guide ended
 * up with a `configurator` whose password anyone could read. `--insecure-fixed-password`
 * keeps the old behaviour for the platform's own throwaway projects.
 */
const password = has('insecure-fixed-password')
  ? 'sandbox-test-password-not-a-secret'
  : randomBytes(24).toString('base64url')

const idp = (endpoint, body) =>
  fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  ).then(async (r) => ({ ok: r.ok, json: await r.json() }))

// Sign up, or sign in if the user already exists. Idempotent by construction so
// repeated runs are free.
let res = await idp('signUp', { email, password, returnSecureToken: true })
if (!res.ok) {
  const reason = res.json?.error?.message ?? ''
  if (!/EMAIL_EXISTS/.test(reason)) {
    console.error(`sandbox-token: signUp failed: ${reason}`)
    process.exit(1)
  }
  res = await idp('signInWithPassword', {
    email,
    password,
    returnSecureToken: true,
  })
  if (!res.ok) {
    console.error(
      `sandbox-token: signIn failed: ${res.json?.error?.message ?? 'unknown'}`
    )
    process.exit(1)
  }
}

const { idToken, localId } = res.json

/**
 * `--grant <role>`: give this test principal a role document.
 *
 * Written DIRECTLY to Firestore rather than through `/doc`, and that is not a
 * shortcut — `role` is owner-only by design (D4: whoever writes it rewrites the
 * input to their own authorization), so there is deliberately no endpoint path
 * for bootstrapping the first privileged principal. D3 names the way out: the
 * datastore holder can always establish roles directly, and that is exactly the
 * credential being used here.
 *
 * Matching is by `userIds` AND `contacts`, because `getUserRoles` tries the uid
 * fast path first and falls back to email — seeding both means the test does not
 * depend on which path runs.
 */
if (val('grant')) {
  // Comma-separated, because roles are INDEPENDENT rather than hierarchical:
  // `owner` is meta-authority over role/config and grants nothing on `post`,
  // which is an `author` collection. A principal that needs to both administer
  // and write content holds both, exactly as a real role document does.
  const roles = val('grant').split(',').map((r) => r.trim()).filter(Boolean)
  const role = roles.join('+')
  const { token } = await import('./sandbox-lib.js')
  const docPath =
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
    `/databases/(default)/documents/role/sandbox-${ROLE}-${RUN}`
  const now = new Date().toISOString()
  const body = {
    fields: {
      name: { stringValue: `Sandbox ${role}` },
      roles: { arrayValue: { values: roles.map((r) => ({ stringValue: r })) } },
      userIds: { arrayValue: { values: [{ stringValue: localId }] } },
      contacts: {
        arrayValue: {
          values: [
            {
              mapValue: {
                fields: {
                  type: { stringValue: 'email' },
                  value: { stringValue: email },
                },
              },
            },
          ],
        },
      },
      _created: { stringValue: now },
      _modified: { stringValue: now },
    },
  }
  const r = await fetch(docPath, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    console.error(`sandbox-token: could not grant ${role}: ${await r.text()}`)
    process.exit(1)
  }
  console.error(`granted ${role} to ${email} (uid ${localId})`)
}

if (EXPORT) {
  console.log(`export SANDBOX_ID_TOKEN=${idToken}`)
  console.log(`export SANDBOX_UID=${localId}`)
  console.log(`export SANDBOX_ROLE_DOC=role/sandbox-${ROLE}-${RUN}`)
  console.log(`export SANDBOX_EMAIL=${email}`)
} else {
  console.error(`project ${projectId}  user ${email}  uid ${localId}`)
  console.log(idToken)
}
