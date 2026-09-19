#!/usr/bin/env bun

/**
 * The acceptance test for #5, run against a real deployed host.
 *
 * A fresh project, a principal with no authority, and a manifest. If this
 * passes, a third party can take this repo, deploy it, and install a library
 * onto it without anyone handing them a secret.
 *
 *   1. an unclaimed host gives an anonymous caller a nonce
 *   2. a principal with NO role cannot install
 *   3. writing the nonce directly into the datastore proves ownership
 *   4. the claim mints `configurator` — and rotates, so it cannot be replayed
 *   5. the manifest installs
 *   6. its collections become live: write, read, list through /doc and /docs
 *   7. a manifest may not declare a platform collection
 *   8. a non-additive upgrade is refused
 *   9. a new capability parks the upgrade without changing what is live
 *  10. revoking makes the collections unreachable — WITHOUT deleting documents
 *
 * Every step asserts. A failure prints what it got and exits non-zero.
 *
 * ## Why this is a script and not a `*.integration.test.ts`
 *
 * It is stateful and ordered end to end — step 4 cannot run twice against the
 * same nonce, by design — so it does not fit a suite that may run tests in any
 * order or re-run one in isolation. It also refuses to run anywhere but a
 * sandbox, through the same `resolveSandbox()` guard as every other script
 * here: it writes directly to the datastore and mints authority.
 *
 * Usage:
 *   bun scripts/verify-install.js              # against the `sandbox` alias
 *   bun scripts/verify-install.js --alias foo
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { resolveSandbox, projectRoot, parseArgs, token } from './sandbox-lib.js'

const { val } = parseArgs(process.argv)
const ALIAS = val('alias') ?? 'sandbox'
const { projectId } = resolveSandbox(ALIAS)
const BASE = `https://us-central1-${projectId}.cloudfunctions.net`
// Cold functions on a fresh deploy are slow; a default fetch timeout has
// produced a false failure here before.
const NET_MS = 30_000

let failures = 0
let step = 0

const ok = (label, condition, detail = '') => {
  step += 1
  const mark = condition ? '  ok' : 'FAIL'
  console.log(`${mark}  ${String(step).padStart(2)}. ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures += 1
  return condition
}

const fatal = (message) => {
  console.error(`\nABORTED: ${message}`)
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

/** Direct datastore access — what the claim ceremony is a proof of. */
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

// ---------------------------------------------------------------------------

console.log(`\nverify-install → ${projectId}\n`)

// A principal with NO role document. Deliberately: the whole point is that a
// fresh host has nobody privileged, and the ceremony is how that changes.
let idToken = ''
let uid = ''
try {
  const out = execSync(
    `bun ${path.join(projectRoot, 'scripts', 'sandbox-token.js')} --alias ${ALIAS} --role installer --export`,
    { encoding: 'utf-8', cwd: projectRoot }
  )
  idToken = (out.match(/SANDBOX_ID_TOKEN=(\S+)/) ?? [])[1] ?? ''
  uid = (out.match(/SANDBOX_UID=(\S+)/) ?? [])[1] ?? ''
} catch (e) {
  fatal(`could not mint a test token: ${e.message}`)
}
if (!idToken) fatal('sandbox-token produced no token')

/**
 * Start from a genuinely unprivileged principal.
 *
 * The claim ceremony creates a role document with a GENERATED id, so deleting
 * a predictable one is not enough: on a second run the principal would already
 * hold `configurator` and the "cannot install without a role" check would pass
 * vacuously — the exact shape of vacuous test this repo has been bitten by.
 * So: find every role document naming this uid, and remove it.
 */
const wipeRolesFor = async (subject) => {
  const listed = await firestore('GET', 'role?pageSize=300')
  for (const d of listed.json?.documents ?? []) {
    const ids = (d.fields?.userIds?.arrayValue?.values ?? []).map(
      (v) => v.stringValue
    )
    if (ids.includes(subject)) {
      const id = d.name.split('/documents/')[1]
      await firestore('DELETE', id)
    }
  }
}
/**
 * Manifests are append-only AND a version's content is immutable, so a previous
 * run's `verify@1.2.0` makes this run's `verify@1.2.0` a 409 the moment the
 * test manifest changes at all. That is the rule working — it caught exactly
 * this when the capability shape changed — but it makes the script
 * non-repeatable unless it clears its own history.
 */
const wipeManifests = async () => {
  const listed = await firestore('GET', 'manifest?pageSize=300')
  for (const d of listed.json?.documents ?? []) {
    const id = d.name.split('/documents/')[1]
    if (id.startsWith('manifest/verify@')) await firestore('DELETE', id)
  }
}
await wipeRolesFor(uid)
await wipeManifests()
await firestore('DELETE', 'grant/verify')
await firestore('DELETE', 'system%3Aclaim/current')

const MANIFEST = {
  manifest: 1,
  name: 'verify',
  version: '1.0.0',
  collections: {
    'verify:task': {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          state: { type: 'string' },
        },
        required: ['title'],
      },
      access: [
        { role: 'public', read: 'ALL', list: 'ALL' },
        { role: 'configurator', write: 'ALL' },
      ],
    },
  },
}

// --- 1. an unclaimed host publishes a nonce to anyone -----------------------
const published = await call('GET', '/claim')
ok(
  'an anonymous caller gets a nonce',
  published.status === 200 && typeof published.json?.nonce === 'string',
  `${published.status} ${published.text.slice(0, 120)}`
)
ok(
  'and the payload carries no claim history',
  // `writeTo.field` legitimately names "proof" — that is the instruction. What
  // must not appear is whether/when the host was claimed before.
  !/claimedBy|claimedAt/.test(published.text),
  published.text.slice(0, 120)
)
const nonce = published.json?.nonce
if (!nonce) fatal('no nonce to work with')

// --- 2. an unprivileged principal cannot install ----------------------------
const early = await call('POST', '/install', {
  bearer: idToken,
  body: { manifest: MANIFEST },
})
ok(
  'a principal with no role cannot install',
  early.status === 403,
  `${early.status} ${early.text.slice(0, 100)}`
)

const beforeProof = await call('POST', '/claim', { bearer: idToken })
ok(
  'and cannot claim without writing the proof',
  beforeProof.status === 403,
  `${beforeProof.status} ${beforeProof.text.slice(0, 80)}`
)

// --- 3/4. prove datastore ownership, then claim -----------------------------
// `updateMask` is load-bearing: a Firestore REST PATCH without one REPLACES
// the document, which would wipe the nonce this proof is meant to match — the
// ceremony would then refuse with `no-nonce` and look like a product bug. A
// human doing this in the console ADDS a field, which is what this imitates.
const wrote = await firestore(
  'PATCH',
  'system%3Aclaim/current?updateMask.fieldPaths=proof',
  { fields: { proof: { stringValue: nonce } } }
)
ok('the proof can be written directly to the datastore', wrote.ok, String(wrote.status))

const claimed = await call('POST', '/claim', { bearer: idToken })
ok(
  'the claim is granted',
  claimed.status === 200 && claimed.json?.granted === 'configurator',
  `${claimed.status} ${claimed.text.slice(0, 160)}`
)

const replay = await call('POST', '/claim', { bearer: idToken })
ok(
  'REPLAYING the same proof is refused — the nonce rotated',
  replay.status === 403,
  `${replay.status} ${replay.text.slice(0, 80)}`
)

const who = await call('GET', '/hello', { bearer: idToken })
ok(
  'the principal now holds configurator, with no token refresh',
  who.json?.userRoles?.roles?.includes('configurator'),
  JSON.stringify(who.json?.userRoles?.roles ?? [])
)

// --- 5. install -------------------------------------------------------------
const installed = await call('POST', '/install', {
  bearer: idToken,
  body: { manifest: MANIFEST },
})
ok(
  'the manifest installs',
  installed.status === 200 && installed.json?.status === 'installed',
  `${installed.status} ${installed.text.slice(0, 160)}`
)

const listed = await call('GET', '/install', { bearer: idToken })
ok(
  'and is listed as installed at 1.0.0',
  listed.json?.installed?.some(
    (i) => i.name === 'verify' && i.version === '1.0.0' && i.status === 'active'
  ),
  listed.text.slice(0, 160)
)

// --- 6. the installed collection is LIVE ------------------------------------
// Mutating methods carry the path in the BODY (`req.body.p`); only GET and
// DELETE read `?p=`.
const created = await call('POST', '/doc', {
  bearer: idToken,
  body: { p: 'verify:task/t1', data: { title: 'first task', state: 'open' } },
})
ok(
  'a document can be written to the installed collection',
  created.status === 200,
  `${created.status} ${created.text.slice(0, 160)}`
)

const read = await call('GET', '/doc?p=verify:task/t1')
ok(
  'and read back by the PUBLIC, exactly as the manifest said',
  read.status === 200 && read.json?.title === 'first task',
  `${read.status} ${read.text.slice(0, 120)}`
)

const listRows = await call('GET', '/docs?p=verify:task&c=10')
ok(
  'and listed',
  listRows.status === 200 && Array.isArray(listRows.json) && listRows.json.length >= 1,
  `${listRows.status} ${listRows.text.slice(0, 120)}`
)

const schemaRefused = await call('POST', '/doc', {
  bearer: idToken,
  body: { p: 'verify:task/t2', data: { state: 'open' } }, // no title
})
ok(
  'the installed SCHEMA is enforced, not just recorded',
  // Not just "400": a malformed request is also 400, and asserting the status
  // alone let this pass while /doc was rejecting the request SHAPE instead.
  schemaRefused.status === 400 && /title/.test(schemaRefused.text),
  `${schemaRefused.status} ${schemaRefused.text.slice(0, 120)}`
)

const anonWrite = await call('POST', '/doc', {
  body: { p: 'verify:task/t3', data: { title: 'not allowed' } },
})
ok(
  'the installed ACCESS rules are enforced — the public cannot write',
  anonWrite.status === 403 || anonWrite.status === 404,
  `${anonWrite.status} ${anonWrite.text.slice(0, 120)}`
)

// --- 7. what a manifest may not declare -------------------------------------
const landGrab = await call('POST', '/install', {
  bearer: idToken,
  body: {
    manifest: {
      ...MANIFEST,
      version: '1.1.0',
      collections: { ...MANIFEST.collections, role: MANIFEST.collections['verify:task'] },
    },
  },
})
ok(
  'a manifest claiming the `role` collection is refused',
  landGrab.status === 400 && /platform collection/.test(landGrab.text),
  `${landGrab.status} ${landGrab.text.slice(0, 160)}`
)

// --- 8. non-additive upgrade -------------------------------------------------
const breaking = await call('POST', '/install', {
  bearer: idToken,
  body: {
    manifest: {
      ...MANIFEST,
      version: '2.0.0',
      collections: {
        'verify:task': {
          ...MANIFEST.collections['verify:task'],
          schema: {
            type: 'object',
            properties: { title: { type: 'string' }, state: { type: 'string' } },
            required: ['title', 'state'], // newly required
          },
        },
      },
    },
  },
})
ok(
  'newly requiring a field is refused as a migration',
  breaking.status === 400 && /newly required/.test(breaking.text),
  `${breaking.status} ${breaking.text.slice(0, 160)}`
)

// --- 9. a new capability parks the upgrade ----------------------------------
const wants = await call('POST', '/install', {
  bearer: idToken,
  body: {
    manifest: {
      ...MANIFEST,
      version: '1.2.0',
      capabilities: {
        'verify:notify': {
          kind: 'outbound',
          host: 'api.example.com',
          access: [{ role: 'configurator', use: 'ALL' }],
        },
      },
    },
  },
})
ok(
  'an upgrade asking for a new capability parks pending approval',
  wants.status === 202 && wants.json?.status === 'needs-approval',
  `${wants.status} ${wants.text.slice(0, 160)}`
)

const stillOld = await call('GET', '/install', { bearer: idToken })
ok(
  'and changes NOTHING live — still 1.0.0, still no capabilities',
  stillOld.json?.installed?.some(
    (i) =>
      i.name === 'verify' &&
      i.version === '1.0.0' &&
      Object.keys(i.capabilities ?? {}).length === 0
  ),
  stillOld.text.slice(0, 200)
)

// The registry excludes revoked tombstones; a PENDING grant must not be
// swept up with them. Asking for one new capability taking the whole library
// offline until somebody clicks approve turns a safety prompt into an outage,
// and teaches operators to approve without reading.
await new Promise((resolve) => setTimeout(resolve, 8000))
const stillLive = await call('GET', '/doc?p=verify:task/t1')
ok(
  'a PENDING upgrade leaves the installed collection live',
  stillLive.status === 200 && stillLive.json?.title === 'first task',
  `${stillLive.status} ${stillLive.text.slice(0, 120)}`
)

const approved = await call('POST', '/install', {
  bearer: idToken,
  body: {
    manifest: {
      ...MANIFEST,
      version: '1.2.0',
      capabilities: {
        'verify:notify': {
          kind: 'outbound',
          host: 'api.example.com',
          access: [{ role: 'configurator', use: 'ALL' }],
        },
      },
    },
    approving: {
      'verify:notify': {
        kind: 'outbound',
        host: 'api.example.com',
        access: [{ role: 'configurator', use: 'ALL' }],
      },
    },
  },
})
ok(
  'approving exactly that capability applies the upgrade',
  approved.status === 200 && approved.json?.status === 'upgraded',
  `${approved.status} ${approved.text.slice(0, 160)}`
)
ok(
  'and the response SAYS the capability is not yet enforced',
  // An approval prompt that overstates what it is asking about is how people
  // learn to stop reading them. Nothing enforces `outbound` yet; say so.
  approved.json?.unenforced?.includes('verify:notify'),
  JSON.stringify(approved.json?.unenforced ?? null)
)

// A capability kind nothing can enforce must be REFUSED, not granted.
const madeUp = await call('POST', '/install', {
  bearer: idToken,
  body: {
    manifest: {
      ...MANIFEST,
      version: '1.3.0',
      capabilities: { 'verify:evil': { kind: 'mine-bitcoin' } },
    },
  },
})
ok(
  'an unrecognised capability kind is refused, not silently granted',
  madeUp.status === 400 && /not a capability this host recognises/.test(madeUp.text),
  `${madeUp.status} ${madeUp.text.slice(0, 160)}`
)

// The escalation the whole in-the-declaration placement exists to stop.
const widened = await call('POST', '/install', {
  bearer: idToken,
  body: {
    manifest: {
      ...MANIFEST,
      version: '1.4.0',
      capabilities: {
        'verify:notify': {
          kind: 'outbound',
          host: 'api.example.com',
          access: [{ role: 'public', use: 'ALL' }],
        },
      },
    },
  },
})
ok(
  'WIDENING a capability from configurator to public re-triggers approval',
  widened.status === 202 && widened.json?.status === 'needs-approval',
  `${widened.status} ${widened.text.slice(0, 160)}`
)

// --- 10. revoke --------------------------------------------------------------
const revoked = await call('DELETE', '/install?name=verify', { bearer: idToken })
ok(
  'the grant can be revoked',
  revoked.status === 200 && revoked.json?.status === 'revoked',
  `${revoked.status} ${revoked.text.slice(0, 160)}`
)

// The registry re-checks its epoch on a short interval; give it one.
await new Promise((resolve) => setTimeout(resolve, 8000))

const afterRevoke = await call('GET', '/doc?p=verify:task/t1')
ok(
  'the collection is no longer reachable',
  afterRevoke.status === 404 || afterRevoke.status === 403,
  `${afterRevoke.status} ${afterRevoke.text.slice(0, 120)}`
)

const survivor = await firestore('GET', 'verify%3Atask/t1')
ok(
  'but the DOCUMENT still exists — uninstall is not deletion',
  survivor.ok && survivor.json?.fields?.title?.stringValue === 'first task',
  `${survivor.status}`
)

// --- cleanup ----------------------------------------------------------------
await firestore('DELETE', 'verify%3Atask/t1')
await firestore('DELETE', 'grant/verify')
await wipeManifests()
await wipeRolesFor(uid)

console.log(
  failures
    ? `\n${failures} of ${step} checks FAILED\n`
    : `\nall ${step} checks passed\n`
)
process.exit(failures ? 1 : 0)
