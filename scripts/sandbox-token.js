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
const email =
  ROLE === 'owner'
    ? (
        fs
          .readFileSync(configPath, 'utf-8')
          .match(/PROJECT_ID = '([^']+)'/) ?? []
      )[1] && 'sandbox-owner@example.test'
    : `sandbox-${ROLE}@example.test`
const password = 'sandbox-test-password-not-a-secret'

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
  const role = val('grant')
  const { token } = await import('./sandbox-lib.js')
  const docPath =
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
    `/databases/(default)/documents/role/sandbox-${ROLE}`
  const now = new Date().toISOString()
  const body = {
    fields: {
      name: { stringValue: `Sandbox ${role}` },
      roles: { arrayValue: { values: [{ stringValue: role }] } },
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
} else {
  console.error(`project ${projectId}  user ${email}  uid ${localId}`)
  console.log(idToken)
}
