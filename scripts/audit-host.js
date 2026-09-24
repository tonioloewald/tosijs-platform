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
 * same audit. Exits 1 when it finds something, so it can gate a deploy.
 */

import {
  readRc,
  token,
  parseArgs,
  claimableGrant,
  OLD_SEED_ADDRESSES,
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
      const fixture =
        /^sandbox-.*@example\.test$/.test(email) ||
        OLD_SEED_ADDRESSES.includes(email)
      if (fixture) {
        found.push({ uid: u.localId, email })
      }
    }
    if (users.length < 500) return found
    offset += users.length
  }
}

console.log(`\naudit-host → ${projectId} (read-only)\n`)

const flagged = (await roleDocs())
  .map(({ id, doc }) => ({ id, why: claimableGrant(id, doc) }))
  .filter((r) => r.why)
const users = await fixtureUsers()

for (const r of flagged) console.log(`   role/${r.id} — ${r.why}`)
for (const u of users ?? []) console.log(`   auth user ${u.email} (uid ${u.uid})`)

if (!flagged.length && users && !users.length) {
  console.log('   clean — no claimable grants, no fixture principals')
  process.exit(0)
}

console.log(
  '\nTo remediate, delete (these are the host owner\'s to decide on):\n' +
    flagged.map((r) => `   firestore: role/${r.id}`).join('\n') +
    (users?.length
      ? '\n' + users.map((u) => `   auth:      ${u.email} (${u.uid})`).join('\n')
      : '') +
    '\n\nThen re-run this until it reports clean.\n'
)
process.exit(1)
