#!/usr/bin/env bun

/**
 * Restore documents from a backup snapshot (see scripts/backup-firestore.js).
 *
 * Closes the gap the 2026-09-06 review named: "a backup that has never been
 * demonstrated to restore is not yet a backup" (F19). The backup encodes
 * Firestore natives as tagged values (`{__type:'timestamp'|'bytes'|...}`) and
 * nothing decoded them, so the restore side was assumed rather than tested.
 *
 * ## Two modes, and the default is the safe one
 *
 *   --dry-run   (DEFAULT) report exactly what would be written, change nothing
 *   --write     actually restore
 *
 * A restore is the most destructive operation in this repo — it overwrites live
 * documents with older ones — so it never runs by accident. `--write` alone is
 * not enough for a full-collection restore; see `--all` below.
 *
 * ## It writes THROUGH `/doc`, not into Firestore
 *
 * The endpoint applies schema validation, provenance stamping, uniqueness and
 * RBAC. Pushing raw documents into Firestore bypasses all four and can restore a
 * shape the current code no longer accepts — a silently corrupt collection that
 * looks fine until something reads it. The cost is that a restore requires an
 * auth token with write access, which is the correct cost.
 *
 * ## Usage
 *
 *   bun scripts/restore-firestore.js --from <snapshot-dir> --doc post/abc123
 *   bun scripts/restore-firestore.js --from <snapshot-dir> --collection post --write
 *   bun scripts/restore-firestore.js --from <snapshot-dir> --all --write --yes
 *
 *   --from <dir>        snapshot directory (contains manifest.json)
 *   --doc <path>        restore ONE document, e.g. post/abc123
 *   --collection <name> restore one collection
 *   --all               restore every collection in the snapshot (needs --yes)
 *   --write             perform writes (default is dry-run)
 *   --yes               required with --all, as a second pair of eyes
 *   --token <idToken>   Firebase ID token; else TOSIJS_ID_TOKEN
 *   --base <url>        service base URL (default https://loewald.com)
 */

import fs from 'fs'
import path from 'path'

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (n) => args.includes(`--${n}`)

const from = flag('from')
const write = has('write')
const base = flag('base') || 'https://loewald.com'
const token = flag('token') || process.env.TOSIJS_ID_TOKEN

if (!from) {
  console.error('Error: --from <snapshot-dir> is required')
  process.exit(1)
}
if (!fs.existsSync(path.join(from, 'manifest.json'))) {
  console.error(`Error: ${from} has no manifest.json — is it a snapshot directory?`)
  process.exit(1)
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(from, 'manifest.json'), 'utf-8')
)

// A partial snapshot restores only what it captured. Restoring "everything" from
// one would silently skip collections it never fetched (see backup F22).
if (has('all') && manifest.complete === false) {
  console.error(
    `Error: ${from} is a PARTIAL snapshot (collections: ${manifest.attempted.join(', ')}).\n` +
      '  Refusing --all. Restore the collections it actually contains explicitly.'
  )
  process.exit(1)
}
if (has('all') && !has('yes')) {
  console.error('Error: --all also requires --yes. This overwrites live documents.')
  process.exit(1)
}

/**
 * Invert the backup's tagged encoding. Kept adjacent to the tags it decodes so
 * the pair cannot drift silently — the review found the two ENCODERS had already
 * drifted (F20), which is the same failure one level up.
 */
function decode(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decode)
  if (typeof value.__type === 'string') {
    switch (value.__type) {
      case 'timestamp':
        return value.value // ISO string; /doc treats dates as strings
      case 'bytes':
        return value.value // base64, round-trips as-is
      case 'reference':
      case 'geopoint':
        return value.value
      default:
        throw new Error(`unknown tagged type ${value.__type}`)
    }
  }
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = decode(v)
  return out
}

/** Envelope fields the endpoint owns — never restored as content. */
const ENVELOPE = ['_id', '_collection', '_path']

function loadDoc(collection, file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const data = decode(raw.data)
  for (const f of ENVELOPE) delete data[f]
  return { id: raw._id, collection, data }
}

function collect() {
  const one = flag('doc')
  if (one) {
    const [collection, id] = one.split('/')
    const file = path.join(from, collection, `${id}.json`)
    if (!fs.existsSync(file)) {
      console.error(`Error: ${one} not found in snapshot`)
      process.exit(1)
    }
    return [loadDoc(collection, file)]
  }
  const names = flag('collection') ? [flag('collection')] : has('all') ? manifest.attempted : null
  if (!names) {
    console.error('Error: one of --doc, --collection or --all is required')
    process.exit(1)
  }
  const out = []
  for (const name of names) {
    const dir = path.join(from, name)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      out.push(loadDoc(name, path.join(dir, f)))
    }
  }
  return out
}

const docs = collect()

console.log(
  `Snapshot ${path.basename(from)} · project ${manifest.project} · taken ${manifest.takenAt}`
)
console.log(`${docs.length} document(s) to restore${write ? '' : ' (DRY RUN)'}\n`)

if (!write) {
  for (const d of docs.slice(0, 20)) {
    const keys = Object.keys(d.data).sort().join(', ')
    console.log(`  ${d.collection}/${d.id}`)
    console.log(`    fields: ${keys}`)
  }
  if (docs.length > 20) console.log(`  … and ${docs.length - 20} more`)
  console.log('\nNothing was written. Re-run with --write to restore.')
  process.exit(0)
}

if (!token) {
  console.error(
    'Error: --write needs an auth token with write access.\n' +
      '  Pass --token <idToken> or set TOSIJS_ID_TOKEN.\n' +
      '  (Restores go through /doc so validation, provenance and RBAC still apply.)'
  )
  process.exit(1)
}

let ok = 0
const failures = []
for (const d of docs) {
  const p = `${d.collection}/${d.id}`
  try {
    // PUT = update an existing document; POST would fail on one that still exists.
    // A restore of a DELETED document therefore needs POST — try PUT, fall back.
    let res = await fetch(`${base}/doc?p=${encodeURIComponent(p)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ data: d.data }),
    })
    if (res.status === 403 || res.status === 404) {
      res = await fetch(`${base}/doc?p=${encodeURIComponent(p)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ data: d.data }),
      })
    }
    if (!res.ok) {
      failures.push({ p, status: res.status, body: (await res.text()).slice(0, 200) })
    } else {
      ok++
      console.log(`  restored ${p}`)
    }
  } catch (e) {
    failures.push({ p, status: 0, body: String(e).slice(0, 200) })
  }
}

console.log(`\n${ok} restored, ${failures.length} failed`)
for (const f of failures) console.error(`  FAILED ${f.p} — ${f.status} ${f.body}`)
process.exit(failures.length > 0 ? 1 : 0)
