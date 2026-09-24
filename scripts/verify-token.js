#!/usr/bin/env bun

/**
 * The acceptance test for scoped capability tokens (B2, #6), against a real
 * deployed host.
 *
 * A token is a bearer secret that will live in a file on a build machine, so
 * almost all of this is about what it CANNOT do. The property everything hangs
 * off is checked last and directly: **revoking the human revokes the agent**,
 * with no revocation list and nothing to remember to do.
 *
 * Refuses to run anywhere but a sandbox — it mints authority and writes to the
 * datastore directly. Same `resolveSandbox()` guard as every script here.
 *
 * Usage: bun scripts/verify-token.js [--alias sandbox]
 */

import { execSync } from 'child_process'
import path from 'path'
import { resolveSandbox, projectRoot, parseArgs, token, assertProbeAllowed } from './sandbox-lib.js'

const { val } = parseArgs(process.argv)
const ALIAS = val('alias') ?? 'sandbox'
const { projectId } = resolveSandbox(ALIAS)
await assertProbeAllowed(projectId)
const BASE = `https://us-central1-${projectId}.cloudfunctions.net`
const NET_MS = 30_000

let failures = 0
let step = 0
const ok = (label, condition, detail = '') => {
  step += 1
  console.log(
    `${condition ? '  ok' : 'FAIL'}  ${String(step).padStart(2)}. ${label}` +
      (detail ? ` — ${detail}` : '')
  )
  if (!condition) failures += 1
  return condition
}
const fatal = (m) => {
  console.error(`\nABORTED: ${m}`)
  process.exit(1)
}

const call = async (method, pathAndQuery, { bearer, body } = {}) => {
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(NET_MS),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, text, json }
}

const firestore = async (method, docPath, body) => {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
      `/databases/(default)/documents/${docPath}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(NET_MS),
    }
  )
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) }
}

console.log(`\nverify-token → ${projectId}\n`)

// A human principal holding author + admin — deliberately NOT owner, so the
// crown-jewel refusals below are testing the rule and not the absence of it.
let human = ''
let uid = ''
let ROLE_DOC = ''
try {
  const out = execSync(
    `bun ${path.join(projectRoot, 'scripts', 'sandbox-token.js')} ` +
      `--alias ${ALIAS} --role agentboss --grant author,admin --export`,
    { encoding: 'utf-8', cwd: projectRoot }
  )
  human = (out.match(/SANDBOX_ID_TOKEN=(\S+)/) ?? [])[1] ?? ''
  uid = (out.match(/SANDBOX_UID=(\S+)/) ?? [])[1] ?? ''
  // The grant lives at a PER-RUN id (`role/sandbox-agentboss-<run>`, #23).
  // This used to be hardcoded to the old fixed id, so the revoke below PATCHed
  // a document that no longer existed — which the REST API happily CREATES —
  // reported a false red, and left a stray author+admin grant behind
  // (0.2.0-beta.3 review, M4). Read it from the minter, never assume it.
  ROLE_DOC = (out.match(/SANDBOX_ROLE_DOC=(\S+)/) ?? [])[1] ?? ''
} catch (e) {
  fatal(`could not mint a human token: ${e.message}`)
}
if (!human) fatal('no human id token')
if (!ROLE_DOC) fatal('sandbox-token did not report SANDBOX_ROLE_DOC')

// --- minting ---------------------------------------------------------------
const mint = (body) => call('POST', '/token', { bearer: human, body })

const minted = await mint({
  label: 'ci × tosijs-platform',
  caveats: { roles: ['author'], collections: ['post'] },
})
ok(
  'a human mints an attenuated token',
  minted.status === 200 && typeof minted.json?.secret === 'string',
  `${minted.status} ${minted.text.slice(0, 140)}`
)
const agent = minted.json?.secret
if (!agent) fatal('no token secret to work with')

ok(
  'the secret is prefixed, so the two credential kinds never get confused',
  agent.startsWith('tsp_'),
  agent.slice(0, 8)
)
ok(
  'DELETE is not granted by default',
  !minted.json?.caveats?.methods?.includes('DELETE'),
  JSON.stringify(minted.json?.caveats?.methods)
)

for (const [role, why] of [
  ['owner', 'rewrites everyone’s authority'],
  ['configurator', 'installs arbitrary collections'],
  ['developer', 'writes module, which /esm executes'],
]) {
  const r = await mint({ label: 'crown jewel probe', caveats: { roles: [role] } })
  ok(
    `a token may never carry "${role}" — ${why}`,
    r.status === 403,
    `${r.status} ${r.text.slice(0, 100)}`
  )
}

const overreach = await mint({
  label: 'overreach probe',
  caveats: { roles: ['editor'] }, // the human holds author + admin, not editor
})
ok(
  'you cannot delegate a role you do not hold',
  overreach.status === 403 && /do not hold/.test(overreach.text),
  `${overreach.status} ${overreach.text.slice(0, 120)}`
)

const unlabelled = await mint({ label: '', caveats: { roles: ['author'] } })
ok(
  'a token must be labelled — the label IS the provenance',
  unlabelled.status === 403,
  `${unlabelled.status} ${unlabelled.text.slice(0, 100)}`
)

// --- the token works, within its caveats ------------------------------------
const wrote = await call('POST', '/doc', {
  bearer: agent,
  body: { p: 'post/token-probe', data: { title: 'by an agent', content: 'x' } },
})
ok(
  'the token can do what it was scoped for',
  wrote.status === 200,
  `${wrote.status} ${wrote.text.slice(0, 140)}`
)

const del = await call('DELETE', '/doc?p=post/token-probe', { bearer: agent })
ok(
  'but NOT a method outside its caveats',
  del.status === 404 || del.status === 403,
  `${del.status} ${del.text.slice(0, 100)}`
)

const offScope = await call('GET', '/doc?p=config/site', { bearer: agent })
ok(
  'and NOT a collection outside its caveats',
  offScope.status === 404,
  `${offScope.status} ${offScope.text.slice(0, 100)}`
)

const agentMint = await call('POST', '/token', {
  bearer: agent,
  body: { label: 'sibling', caveats: { roles: ['author'] } },
})
ok(
  'a token cannot mint another token',
  agentMint.status === 403 && /may not mint another token/.test(agentMint.text),
  `${agentMint.status} ${agentMint.text.slice(0, 120)}`
)
// --- listing never exposes a secret -----------------------------------------
const listed = await call('GET', '/token', { bearer: human })
ok(
  'listing shows the tokens but no secrets — they are not stored',
  listed.status === 200 &&
    listed.json?.tokens?.length > 0 &&
    !/tsp_/.test(listed.text) &&
    !/"hash"/.test(listed.text),
  `${listed.status} ${listed.text.slice(0, 140)}`
)

// --- THE property: revoking the human revokes the agent ---------------------
const before = await call('GET', '/hello', { bearer: agent })
ok(
  'the agent resolves to its attenuated role',
  JSON.stringify(before.json?.userRoles?.roles ?? []) === '["author"]',
  JSON.stringify(before.json?.userRoles?.roles ?? [])
)
ok(
  'and carries its label as provenance',
  before.json?.userRoles?.token?.label === 'ci × tosijs-platform',
  JSON.stringify(before.json?.userRoles?.token ?? null)
)

// Revoke the HUMAN's roles, touching nothing about the token.
// `currentDocument.exists=true`: a PATCH to a missing document would CREATE it,
// so a wrong id must fail loudly here instead of passing vacuously.
const revoked = await firestore(
  'PATCH',
  `${ROLE_DOC}?updateMask.fieldPaths=roles&currentDocument.exists=true`,
  { fields: { roles: { arrayValue: { values: [] } } } }
)
if (!revoked.ok) fatal(`could not revoke ${ROLE_DOC}: ${revoked.status}`)
const after = await call('GET', '/hello', { bearer: agent })
ok(
  'REVOKING THE HUMAN REVOKES THE AGENT — no revocation list, nothing to remember',
  JSON.stringify(after.json?.userRoles?.roles ?? []) === '[]',
  JSON.stringify(after.json?.userRoles?.roles ?? [])
)

const afterWrite = await call('POST', '/doc', {
  bearer: agent,
  body: { p: 'post/token-probe-2', data: { title: 'should fail', content: 'x' } },
})
ok(
  'and the agent can no longer write',
  afterWrite.status === 404 || afterWrite.status === 403,
  `${afterWrite.status} ${afterWrite.text.slice(0, 100)}`
)

// --- cleanup ----------------------------------------------------------------
// Re-grant briefly so the human may delete their own token record, then
// delete the per-run grant outright.
await firestore(
  'PATCH',
  `${ROLE_DOC}?updateMask.fieldPaths=roles&currentDocument.exists=true`,
  {
    fields: {
      roles: {
        arrayValue: { values: [{ stringValue: 'author' }, { stringValue: 'admin' }] },
      },
    },
  }
)
if (minted.json?.id) {
  await call('DELETE', `/token?id=${minted.json.id}`, { bearer: human })
}
// The grant was minted for THIS run, so it is deleted rather than restored —
// restoring it left an author+admin grant behind after every run.
await firestore('DELETE', ROLE_DOC)
await firestore('DELETE', 'post/token-probe')

console.log(
  failures
    ? `\n${failures} of ${step} checks FAILED\n`
    : `\nall ${step} checks passed\n`
)
process.exit(failures ? 1 : 0)
