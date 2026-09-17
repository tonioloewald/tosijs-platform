#!/usr/bin/env bun

/**
 * Back up Cloud Storage objects — CONTENT-ADDRESSED, so each image is stored
 * once no matter how many snapshots reference it.
 *
 * `backup-firestore.js` covers documents. The bucket holds the blog's images —
 * 135 objects, ~164 MB — and had no backup at all.
 *
 * ## Why content-addressed
 *
 * The naive design (a full copy per nightly snapshot) would write 164 MB every
 * night to keep 30 days, for data that essentially never changes: ~5 GB locally
 * and again in every cloud destination, to protect 164 MB. Instead:
 *
 *   objects/<md5-hex>          the bytes, stored ONCE, keyed by content
 *   <snapshot>/storage.json    a manifest naming which objects that snapshot had
 *
 * A nightly run downloads only blobs it has never seen — normally none — and
 * writes a small manifest. Renaming an image costs nothing; re-uploading an
 * identical one costs nothing. The bucket already contains two objects that are
 * byte-identical, and they occupy one slot here.
 *
 * Restoring a snapshot therefore needs the shared `objects/` store as well as
 * the snapshot directory. That is the trade for not storing 30 copies, and it is
 * why `--gc` only ever deletes blobs no surviving manifest mentions.
 *
 * ## Integrity
 *
 * Every download is verified against the md5 the bucket reported, and a blob
 * that fails is discarded rather than stored. A silently corrupt backup is worse
 * than a missing one, because it is trusted.
 *
 * ## Auth
 *
 * Uses the Storage JSON API with a `gcloud auth print-access-token` token — the
 * same transport as the Firestore backup's REST fallback, so no ADC needed.
 *
 * Usage:
 *   bun scripts/backup-storage.js                 # snapshot manifest + any new blobs
 *   bun scripts/backup-storage.js --dry-run
 *   bun scripts/backup-storage.js --gc            # drop unreferenced blobs
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const has = (n) => args.includes(`--${n}`)
const val = (n) => {
  const i = args.indexOf(`--${n}`)
  return i !== -1 ? args[i + 1] : undefined
}
const DRY = has('dry-run')
const GC = has('gc')
const QUIET = has('quiet')
const log = (...a) => {
  if (!QUIET) console.log(...a)
}

const projectId =
  val('project') ||
  JSON.parse(fs.readFileSync(path.join(projectRoot, '.firebaserc'), 'utf-8'))
    .projects?.default

if (!projectId) {
  console.error('backup-storage: could not read project id')
  process.exit(1)
}

const bucket = val('bucket') || `${projectId}.appspot.com`
const backupRoot = path.join(os.homedir(), 'Backups', 'tosijs-platform', projectId)
const objectsDir = path.join(backupRoot, 'storage', 'objects')

const token = () =>
  execSync('gcloud auth print-access-token', {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

/** base64 md5 (what GCS reports) -> hex, which makes a sane filename. */
const toHex = (b64) => Buffer.from(b64, 'base64').toString('hex')

const blobPath = (hex) => path.join(objectsDir, hex.slice(0, 2), hex)

async function listObjects(tok) {
  const out = []
  let pageToken
  do {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${bucket}/o`)
    url.searchParams.set(
      'fields',
      'items(name,size,md5Hash,contentType,updated,generation),nextPageToken'
    )
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })
    if (!res.ok) {
      throw new Error(`list failed: ${res.status} ${await res.text()}`)
    }
    const json = await res.json()
    out.push(...(json.items ?? []))
    pageToken = json.nextPageToken
  } while (pageToken)
  return out
}

async function download(tok, name) {
  const url =
    `https://storage.googleapis.com/storage/v1/b/${bucket}/o/` +
    `${encodeURIComponent(name)}?alt=media`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Newest complete Firestore snapshot — the manifest belongs beside it. */
const newestSnapshot = () => {
  if (!fs.existsSync(backupRoot)) return null
  const dirs = fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse()
  return dirs.find((d) =>
    fs.existsSync(path.join(backupRoot, d, 'manifest.json'))
  )
}

async function main() {
  const tok = token()
  const objects = await listObjects(tok)
  const withHash = objects.filter((o) => o.md5Hash)
  const noHash = objects.filter((o) => !o.md5Hash)

  const unique = new Map()
  for (const o of withHash) unique.set(toHex(o.md5Hash), o)

  const totalBytes = withHash.reduce((n, o) => n + Number(o.size || 0), 0)
  log(`bucket   ${bucket}`)
  log(
    `objects  ${objects.length} (${(totalBytes / 1048576).toFixed(1)} MB), ` +
      `${unique.size} unique by content`
  )
  if (noHash.length) {
    // Composite objects have no md5. Report rather than skip silently.
    console.error(
      `  WARNING: ${noHash.length} object(s) have no md5 and were NOT backed up:\n` +
        noHash.slice(0, 5).map((o) => `    ${o.name}`).join('\n')
    )
  }

  const missing = [...unique.entries()].filter(
    ([hex]) => !fs.existsSync(blobPath(hex))
  )
  const missingBytes = missing.reduce((n, [, o]) => n + Number(o.size || 0), 0)
  log(
    `new      ${missing.length} blob(s) to fetch ` +
      `(${(missingBytes / 1048576).toFixed(1)} MB); ` +
      `${unique.size - missing.length} already stored`
  )

  if (!DRY) {
    let fetched = 0
    let failed = 0
    for (const [hex, o] of missing) {
      try {
        const body = await download(tok, o.name)
        const actual = crypto.createHash('md5').update(body).digest('hex')
        if (actual !== hex) {
          // Discard rather than store: a corrupt blob that is TRUSTED is worse
          // than an absent one.
          failed++
          console.error(`  CHECKSUM MISMATCH ${o.name} — discarded`)
          continue
        }
        const dest = blobPath(hex)
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
        fs.writeFileSync(dest, body, { mode: 0o600 })
        fetched++
      } catch (e) {
        failed++
        console.error(`  FAILED ${o.name}: ${e.message}`)
      }
    }
    log(`fetched  ${fetched}${failed ? `, ${failed} FAILED` : ''}`)
    if (failed) process.exitCode = 1
  }

  // The manifest: what this snapshot's bucket looked like, by content.
  const manifest = {
    bucket,
    takenAt: new Date().toISOString(),
    objects: withHash
      .map((o) => ({
        name: o.name,
        md5: toHex(o.md5Hash),
        size: Number(o.size || 0),
        contentType: o.contentType,
        updated: o.updated,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    skipped: noHash.map((o) => o.name),
  }

  const snapshot = newestSnapshot()
  if (!snapshot) {
    console.error(
      'backup-storage: no Firestore snapshot to attach the manifest to.\n' +
        '  Run `bun run backup` first — storage manifests live beside it.'
    )
    process.exit(1)
  }
  const manifestPath = path.join(backupRoot, snapshot, 'storage.json')
  if (DRY) {
    log(`  [dry-run] would write ${path.relative(backupRoot, manifestPath)}`)
  } else {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    })
    log(`manifest ${path.relative(backupRoot, manifestPath)}`)
  }

  if (GC) {
    // Referenced = named by ANY surviving snapshot manifest. Pruning snapshots
    // is what eventually frees a blob; this never guesses.
    const referenced = new Set()
    for (const d of fs.readdirSync(backupRoot)) {
      const sm = path.join(backupRoot, d, 'storage.json')
      if (!fs.existsSync(sm)) continue
      try {
        for (const o of JSON.parse(fs.readFileSync(sm, 'utf-8')).objects ?? []) {
          referenced.add(o.md5)
        }
      } catch {
        // An unreadable manifest means we cannot prove a blob is unreferenced,
        // so treat it as referencing everything: refuse to GC at all.
        console.error(`  unreadable ${sm} — skipping GC entirely`)
        return
      }
    }
    let freed = 0
    let removed = 0
    if (fs.existsSync(objectsDir)) {
      for (const prefix of fs.readdirSync(objectsDir)) {
        const dir = path.join(objectsDir, prefix)
        for (const hex of fs.readdirSync(dir)) {
          if (referenced.has(hex)) continue
          const p = path.join(dir, hex)
          freed += fs.statSync(p).size
          if (!DRY) fs.unlinkSync(p)
          removed++
        }
      }
    }
    log(
      `gc       ${removed} unreferenced blob(s)` +
        `${removed ? ` (${(freed / 1048576).toFixed(1)} MB)` : ''}` +
        `${DRY ? ' [dry-run]' : ''}`
    )
  }
}

main().catch((e) => {
  console.error(`\nbackup-storage failed: ${e.message}`)
  process.exit(1)
})
