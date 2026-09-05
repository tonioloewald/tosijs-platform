#!/usr/bin/env bun

/**
 * Back up production Firestore to timestamped JSON on disk.
 *
 * The blog is append-mostly and small, so a full dump every time is simpler and
 * safer than an incremental scheme — there is no merge logic to get wrong, and
 * any single snapshot is a complete, restorable picture.
 *
 * READ-ONLY. This script never writes to Firestore. Restore is deliberately a
 * separate, manual step (see RESTORING below) so a backup run can never be the
 * thing that destroys data.
 *
 * Backups land OUTSIDE the repo by default (~/Backups/tosijs-platform). A backup
 * inside the working tree is destroyed by the same `rm -rf`, bad merge or stray
 * `git clean` that destroys everything else, so it is not a failsafe. Nothing
 * here is ever committed.
 *
 * Usage:
 *   bun run backup                      # dump every known collection
 *   bun run backup -- --out <dir>       # write somewhere else
 *   bun run backup -- --collection post # dump one collection
 *   bun run backup -- --quiet           # only print the summary line (for cron)
 *   bun run backup -- --keep 30         # prune to the newest 30 snapshots
 *
 * Auth: application default credentials, same as scripts/seed-production.js.
 * If it fails with a credentials error, run `gcloud auth application-default login`.
 *
 * RESTORING (manual, on purpose):
 *   Each document is one JSON file under <backup>/<collection>/<docId>.json, so a
 *   single lost post can be restored by hand without a tool. For a bulk restore,
 *   write it against `/doc` (so validation, provenance and RBAC all still apply)
 *   rather than pushing raw documents back into Firestore.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

// firebase-admin is installed under functions/ (npm-managed), not at the root, so
// import it by explicit path rather than duplicating a heavy dep in the root
// project. Same reason scripts/seed-production.js must run with it available.
const adminDir = path.join(projectRoot, 'functions', 'node_modules', 'firebase-admin')

// Collections registered in functions/src/collections + the content collections.
// A collection missing here is simply not backed up, so keep it in sync when a
// new one is added — the summary prints what it found, which makes a forgotten
// collection visible as a zero.
const COLLECTIONS = ['post', 'page', 'module', 'config', 'role']

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name) => args.includes(`--${name}`)
const quiet = has('quiet')
const log = (...a) => {
  if (!quiet) console.log(...a)
}

function getProjectId() {
  try {
    const firebaserc = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.firebaserc'), 'utf-8')
    )
    return firebaserc.projects?.default
  } catch {
    return null
  }
}

const PROJECT_ID = getProjectId()
if (!PROJECT_ID) {
  console.error('Error: could not read project ID from .firebaserc')
  process.exit(1)
}

// Timestamp is filesystem- and sort-safe: 2026-09-05T12-00-00Z
const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..*$/, 'Z')
// Default OUTSIDE the repo — see the header. Never committed, never cleaned by git.
const outRoot =
  flag('out') ||
  process.env.TOSIJS_BACKUP_DIR ||
  path.join(os.homedir(), 'Backups', 'tosijs-platform')
const outDir = path.join(outRoot, stamp)
const only = flag('collection')
const targets = only ? [only] : COLLECTIONS

/**
 * Two transports, because the credential situation differs by machine:
 *
 *  - **admin** — firebase-admin with application default credentials. Preferred:
 *    it is what the emulator path uses (`FIRESTORE_EMULATOR_HOST`) and what a
 *    service account would use on a server.
 *  - **rest** — the Firestore REST API with a token from `gcloud auth
 *    print-access-token`. Fallback for the common case of a developer machine
 *    that has `gcloud`/`firebase` logged in but has never run the *separate*
 *    `gcloud auth application-default login`. Without this the script is only
 *    runnable after an interactive login, which is a poor property for a failsafe.
 *
 * The manifest records which transport ran, so a surprising result can be traced
 * to how it was fetched.
 */
async function makeReader() {
  // The emulator needs no credentials, so honour it before anything else.
  const emulator = process.env.FIRESTORE_EMULATOR_HOST
  const hasAdc =
    !!process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    fs.existsSync(
      path.join(os.homedir(), '.config/gcloud/application_default_credentials.json')
    )

  if ((emulator || hasAdc) && fs.existsSync(adminDir)) {
    const { initializeApp } = await import(path.join(adminDir, 'lib/app/index.js'))
    const { getFirestore } = await import(
      path.join(adminDir, 'lib/firestore/index.js')
    )
    initializeApp({ projectId: PROJECT_ID })
    const db = getFirestore()
    return {
      transport: emulator ? 'admin(emulator)' : 'admin',
      read: async (name) => {
        const snap = await db.collection(name).get()
        return snap.docs.map((d) => ({ id: d.id, data: serialize(d.data()) }))
      },
    }
  }

  // REST fallback via the already-authenticated gcloud user.
  const { execSync } = await import('child_process')
  let token
  try {
    token = execSync('gcloud auth print-access-token', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    console.error(
      'Error: no usable credentials.\n' +
        '  Either: gcloud auth application-default login\n' +
        '  Or:     gcloud auth login   (this script will then use an access token)'
    )
    process.exit(1)
  }

  const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`
  return {
    transport: 'rest(gcloud-token)',
    read: async (name) => {
      const docs = []
      let pageToken
      do {
        const url = new URL(`${base}/${name}`)
        url.searchParams.set('pageSize', '300')
        if (pageToken) url.searchParams.set('pageToken', pageToken)
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`)
        }
        const body = await res.json()
        for (const d of body.documents || []) {
          docs.push({
            id: d.name.split('/').pop(),
            data: decodeRestFields(d.fields || {}),
          })
        }
        pageToken = body.nextPageToken
      } while (pageToken)
      return docs
    },
  }
}

/** Decode the Firestore REST wire format into plain JSON. */
function decodeRestValue(v) {
  if ('nullValue' in v) return null
  if ('booleanValue' in v) return v.booleanValue
  if ('stringValue' in v) return v.stringValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('timestampValue' in v) {
    return { __type: 'timestamp', value: v.timestampValue }
  }
  if ('bytesValue' in v) return { __type: 'bytes', value: v.bytesValue }
  if ('referenceValue' in v) {
    return { __type: 'reference', value: v.referenceValue }
  }
  if ('geoPointValue' in v) {
    return { __type: 'geopoint', value: v.geoPointValue }
  }
  if ('arrayValue' in v) {
    return (v.arrayValue.values || []).map(decodeRestValue)
  }
  if ('mapValue' in v) return decodeRestFields(v.mapValue.fields || {})
  return null
}

function decodeRestFields(fields) {
  const out = {}
  for (const [k, v] of Object.entries(fields)) out[k] = decodeRestValue(v)
  return out
}

/**
 * Firestore Timestamps (and other admin-SDK types) do not survive JSON.stringify
 * as anything restorable, so convert them to a tagged form we can recognise later.
 * Everything else is passed through structurally.
 */
function serialize(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.toDate === 'function') {
    return { __type: 'timestamp', value: value.toDate().toISOString() }
  }
  if (Array.isArray(value)) return value.map(serialize)
  if (Buffer.isBuffer(value)) {
    return { __type: 'bytes', value: value.toString('base64') }
  }
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = serialize(v)
  return out
}

const reader = await makeReader()

async function backupCollection(name) {
  const docs = await reader.read(name)
  const dir = path.join(outDir, name)
  fs.mkdirSync(dir, { recursive: true })

  let bytes = 0
  for (const doc of docs) {
    // Doc ids can contain '/' in sub-collection paths; keep the file name flat.
    const safeId = doc.id.replace(/[/\\]/g, '_')
    const body = JSON.stringify(
      { _id: doc.id, _collection: name, data: doc.data },
      null,
      2
    )
    fs.writeFileSync(path.join(dir, `${safeId}.json`), body)
    bytes += Buffer.byteLength(body)
  }
  return { name, count: docs.length, bytes }
}

const results = []
let failed = 0

for (const name of targets) {
  try {
    const r = await backupCollection(name)
    results.push(r)
    log(`  ${name.padEnd(10)} ${String(r.count).padStart(5)} docs  ${(r.bytes / 1024).toFixed(1)} KB`)
  } catch (e) {
    failed++
    console.error(`  ${name.padEnd(10)} FAILED: ${e.message}`)
  }
}

const totalDocs = results.reduce((n, r) => n + r.count, 0)
const totalBytes = results.reduce((n, r) => n + r.bytes, 0)

// A manifest makes a backup self-describing — which collections were attempted,
// what was found, and whether anything failed. A restore should read this first.
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify(
    {
      project: PROJECT_ID,
      takenAt: new Date().toISOString(),
      transport: reader.transport,
      collections: results,
      attempted: targets,
      failed,
      totalDocs,
      totalBytes,
    },
    null,
    2
  )
)

// An empty backup is almost always a broken backup (bad credentials, wrong
// project) rather than a genuinely empty site — fail loudly rather than leaving
// a reassuring empty directory behind.
if (failed > 0 || totalDocs === 0) {
  console.error(
    `\nBackup FAILED — ${failed} collection(s) errored, ${totalDocs} documents captured.\n` +
      `  ${outDir}\n` +
      `  If this is a credentials problem: gcloud auth application-default login`
  )
  process.exit(1)
}

// Retention. Only ever runs AFTER a verified-good backup above, so a failing run
// can never prune the last known-good snapshot out from under us.
const keep = Number(flag('keep') || 0)
if (keep > 0) {
  const snapshots = fs
    .readdirSync(outRoot)
    .filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d))
    .sort()
    .reverse()
  for (const old of snapshots.slice(keep)) {
    fs.rmSync(path.join(outRoot, old), { recursive: true, force: true })
    log(`  pruned ${old}`)
  }
}

console.log(
  `Backup OK — ${totalDocs} docs, ${(totalBytes / 1024).toFixed(1)} KB → ${outDir}`
)
