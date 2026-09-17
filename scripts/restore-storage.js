#!/usr/bin/env bun

/**
 * Restore Cloud Storage objects from a content-addressed backup.
 *
 * The counterpart to `backup-storage.js`. A backup nobody has ever restored is a
 * hypothesis, not a backup — and this one has an extra failure mode worth
 * proving against: the bytes live in a SHARED `storage/objects/` store rather
 * than inside the snapshot, so a restore needs both halves to be present.
 *
 * Reads `<snapshot>/storage.json` (names -> content hashes) and uploads each
 * blob back under its original name and content type.
 *
 * ## Safety
 *
 * - DRY RUN BY DEFAULT; `--write` required.
 * - Verifies every blob against the manifest's md5 BEFORE uploading anything,
 *   and refuses the whole run if any are missing or corrupt. A half-restored
 *   bucket is worse than one that did not start, because the gaps are silent.
 * - Skips objects already present with matching content, so re-running is cheap
 *   and safe.
 * - `--bucket` targets somewhere other than the manifest's own bucket, which is
 *   how you rehearse into the sandbox instead of production.
 *
 * Usage:
 *   bun scripts/restore-storage.js --from <snapshot-dir>
 *   bun scripts/restore-storage.js --from <snapshot-dir> --write
 *   bun scripts/restore-storage.js --from <snapshot-dir> --bucket other --write
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
const WRITE = has('write')
const from = val('from')

if (!from) {
  console.error('Error: --from <snapshot-dir> is required')
  process.exit(1)
}

const manifestPath = path.join(from, 'storage.json')
if (!fs.existsSync(manifestPath)) {
  console.error(
    `Error: no storage.json in ${from}\n` +
      '  That snapshot predates storage backups, or `bun run backup:storage` never ran for it.'
  )
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
const bucket = val('bucket') || manifest.bucket

const projectId = JSON.parse(
  fs.readFileSync(path.join(projectRoot, '.firebaserc'), 'utf-8')
).projects?.default
const objectsDir = path.join(
  os.homedir(),
  'Backups',
  'tosijs-platform',
  projectId,
  'storage',
  'objects'
)
const blobPath = (hex) => path.join(objectsDir, hex.slice(0, 2), hex)

const token = () =>
  execSync('gcloud auth print-access-token', {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

console.log(`snapshot ${path.basename(from)}`)
console.log(`bucket   ${bucket}${bucket === manifest.bucket ? '' : '  (OVERRIDDEN)'}`)
console.log(`objects  ${manifest.objects.length}`)

// ---- Preflight: every blob present and intact, BEFORE touching the bucket ----
const missing = []
const corrupt = []
for (const o of manifest.objects) {
  const p = blobPath(o.md5)
  if (!fs.existsSync(p)) {
    missing.push(o)
    continue
  }
  const actual = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')
  if (actual !== o.md5) corrupt.push(o)
}

if (missing.length || corrupt.length) {
  console.error(
    `\nREFUSING to restore — the blob store is incomplete.\n` +
      (missing.length
        ? `  ${missing.length} missing (e.g. ${missing[0].name})\n`
        : '') +
      (corrupt.length
        ? `  ${corrupt.length} corrupt (e.g. ${corrupt[0].name})\n`
        : '') +
      `\nBlobs live in ${objectsDir}, shared across snapshots. If this machine\n` +
      `was rebuilt, copy storage-objects/ back from iCloud/Drive first.\n`
  )
  process.exit(1)
}
console.log(`preflight all ${manifest.objects.length} blob(s) present and intact`)

if (!WRITE) {
  console.log('\nDRY RUN — nothing uploaded. Re-run with --write.')
  process.exit(0)
}

const tok = token()
let uploaded = 0
let skipped = 0
const failures = []

for (const o of manifest.objects) {
  try {
    // Already there with the same content? Leave it alone.
    const head = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(o.name)}?fields=md5Hash`,
      { headers: { Authorization: `Bearer ${tok}` } }
    )
    if (head.ok) {
      const existing = await head.json()
      if (
        existing.md5Hash &&
        Buffer.from(existing.md5Hash, 'base64').toString('hex') === o.md5
      ) {
        skipped++
        continue
      }
    }

    const body = fs.readFileSync(blobPath(o.md5))
    const res = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o` +
        `?uploadType=media&name=${encodeURIComponent(o.name)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tok}`,
          'Content-Type': o.contentType || 'application/octet-stream',
        },
        body,
      }
    )
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
    uploaded++
  } catch (e) {
    failures.push(`${o.name}: ${e.message}`)
  }
}

console.log(
  `\nuploaded ${uploaded}, unchanged ${skipped}` +
    (failures.length ? `, FAILED ${failures.length}` : '')
)
for (const f of failures.slice(0, 10)) console.error(`  ${f}`)
if (failures.length) process.exit(1)
