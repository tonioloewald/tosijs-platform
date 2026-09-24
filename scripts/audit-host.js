#!/usr/bin/env bun
/**
 * READ-ONLY audit of a host for grants somebody else could claim (#23, B1).
 *
 * The 0.2.0-beta.3 seed fix protects hosts seeded from now on. A host seeded
 * earlier still carries role documents keyed on `owner@gmail.com` and friends —
 * real, registrable addresses, and role resolution matches on contact email —
 * and a host the verify scripts ran against carries `sandbox-*` grants whose
 * password used to be a constant in this repo. Nothing removes either.
 *
 * This lists them and the Auth users behind them, and prints what to delete.
 * It changes NOTHING: deleting a principal from somebody's host is theirs to
 * decide, so the fix is printed, not applied.
 *
 *   bun scripts/audit-host.js --alias <alias>
 *
 * Any alias, `default` included — reading is safe, and production deserves the
 * same audit. Exit codes: 0 no claimable grants (leftovers are reported, not
 * failed), 1 claimable grants found, 3 incomplete (the Auth half could not be
 * listed — fails closed). Needs this repo and gcloud user credentials; a
 * consumer without them can check the same things in the Firebase console.
 */

import {
  readRc,
  token,
  parseArgs,
  claimableGrant,
  fixtureUser,
} from './sandbox-lib.js'

const { val } = parseArgs(process.argv)
const alias = val('alias')
const projectId = alias ? readRc().projects?.[alias] : null
if (!projectId) {
  console.error(
    `usage: bun scripts/audit-host.js --alias <alias>\n` +
      `known: ${Object.keys(readRc().projects ?? {}).join(', ') || '(none)'}`
  )
  process.exit(2)
}

const bearer = token()
const headers = {
  Authorization: `Bearer ${bearer}`,
  'Content-Type': 'application/json',
  // User credentials against an admin API need a quota project.
  'x-goog-user-project': projectId,
}

/** Decode the few Firestore REST value shapes a role document uses. */
const decode = (v) => {
  if (!v || typeof v !== 'object') return v
  if ('stringValue' in v) return v.stringValue
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decode)
  if ('mapValue' in v) {
    return Object.fromEntries(
      Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)])
    )
  }
  return Object.values(v)[0]
}

async function roleDocs() {
  const out = []
  let pageToken
  do {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/role`
    )
    url.searchParams.set('pageSize', '300')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`role list: ${res.status} ${await res.text()}`)
    const body = await res.json()
    for (const d of body.documents ?? []) {
      const fields = Object.fromEntries(
        Object.entries(d.fields ?? {}).map(([k, v]) => [k, decode(v)])
      )
      out.push({ id: d.name.split('/').pop(), doc: fields })
    }
    pageToken = body.nextPageToken
  } while (pageToken)
  return out
}

async function fixtureUsers() {
  const found = []
  let offset = 0
  for (;;) {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:query`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ returnUserInfo: true, limit: '500', offset: String(offset) }),
      }
    )
    if (!res.ok) {
      console.error(`   (could not list Auth users: ${res.status} — check them by hand)`)
      return null
    }
    const body = await res.json()
    const users = body.userInfo ?? []
    for (const u of users) {
      const email = String(u.email ?? '').toLowerCase()
      const hit = fixtureUser(email)
      if (hit) found.push({ uid: u.localId, email, ...hit })
    }
    if (users.length < 500) return found
    offset += users.length
  }
}

console.log(`\naudit-host → ${projectId} (read-only)\n`)

const roles = (await roleDocs())
  .map(({ id, doc }) => ({ id, doc, ...(claimableGrant(id, doc) ?? {}) }))
  .filter((r) => r.severity)
const users = await fixtureUsers()

const claimable = [
  ...roles.filter((r) => r.severity === 'claimable').map((r) => `role/${r.id} — ${r.why}`),
  ...(users ?? []).filter((u) => u.severity === 'claimable').map((u) => `auth ${u.email} (${u.uid}) — ${u.why}`),
]
const leftover = [
  ...roles.filter((r) => r.severity === 'leftover').map((r) => `role/${r.id} — ${r.why}`),
  ...(users ?? []).filter((u) => u.severity === 'leftover').map((u) => `auth ${u.email} (${u.uid}) — ${u.why}`),
]

if (claimable.length) {
  console.log('CLAIMABLE — somebody else could sign in and hold these:\n')
  for (const line of claimable) console.log(`   ${line}`)
  // A flagged grant may be the ONLY path in with authority. Deleting it first
  // locks the owner out (recoverable by re-claiming, but needlessly).
  const load = roles.filter(
    (r) =>
      r.severity === 'claimable' &&
      (r.doc.roles ?? []).some((x) => x === 'owner' || x === 'configurator')
  )
  if (load.length) {
    console.log(
      '\n   ⚠ holds owner/configurator: ' + load.map((r) => `role/${r.id}`).join(', ') +
        '\n     Grant that authority to a VERIFIED identity of yours first, and confirm\n' +
        '     it with GET /hello, BEFORE deleting these — or you lock yourself out.'
    )
  }
}
if (leftover.length) {
  console.log('\nLeftover — not claimable (random passwords), worth deleting:\n')
  for (const line of leftover) console.log(`   ${line}`)
}

if (users === null) {
  // Fail closed: "no claimable roles" says nothing about the Auth half.
  console.log('\nINCOMPLETE — the Auth user listing failed; check fixture users by hand.')
  process.exit(3)
}
if (!claimable.length) {
  console.log(leftover.length ? '\nclean of claimable grants' : '   clean')
  process.exit(0)
}
console.log(
  '\nDelete the CLAIMABLE entries (the host owner decides), then re-run until clean.\n'
)
process.exit(1)
