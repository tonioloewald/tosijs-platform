#!/usr/bin/env bun

/**
 * Copy a backup snapshot OFF this machine, gzipped.
 *
 * `backup-firestore.js` writes a snapshot to `~/Backups/…`, which protects
 * against a bad deploy, a wrong migration or a fat-fingered delete. It does not
 * protect against losing the machine. This does: one compressed archive per
 * snapshot, copied into iCloud Drive and/or Google Drive, which are already
 * syncing off-device.
 *
 * ## What it archives, and what it deliberately does not
 *
 * By default the `role` collection is EXCLUDED, and that is a considered
 * decision rather than an oversight:
 *
 *   - `role` documents carry real contact details — email, phone, mailing
 *     address — for real people. That is why the local backup writes 0600 files
 *     inside 0700 directories. Copying them into a consumer sync service is a
 *     material change in exposure, and not one to make silently on someone's
 *     behalf.
 *   - It is also the least necessary thing to have off-site. Per DECISIONS.md
 *     D3, `owner` is the in-system reflection of datastore ownership, so whoever
 *     holds the cloud project can always re-establish roles directly. Posts
 *     cannot be re-created that way.
 *
 * So the default archive is exactly "the content, recoverable from anywhere".
 * `--include-roles` puts them in, and the run says loudly which it did.
 *
 * ## Usage
 *
 *   bun scripts/archive-backup.js                  # newest snapshot -> detected clouds
 *   bun scripts/archive-backup.js --dry-run
 *   bun scripts/archive-backup.js --include-roles
 *   bun scripts/archive-backup.js --to ~/somewhere # explicit destination (repeatable)
 *   bun scripts/archive-backup.js --keep 30        # prune archives at each destination
 *
 * Exit codes: 0 archived (or nothing to do), 1 on failure. Safe to chain after
 * the backup in the LaunchAgent.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const has = (n) => args.includes(`--${n}`)
const val = (n) => {
  const i = args.indexOf(`--${n}`)
  return i !== -1 ? args[i + 1] : undefined
}
const all = (n) =>
  args.reduce(
    (acc, a, i) => (a === `--${n}` && args[i + 1] ? [...acc, args[i + 1]] : acc),
    []
  )

const DRY = has('dry-run')
const INCLUDE_ROLES = has('include-roles')
const KEEP = Number(val('keep') ?? 30)
const QUIET = has('quiet')
const log = (...a) => {
  if (!QUIET) console.log(...a)
}

const projectId = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.firebaserc'), 'utf-8')
    ).projects?.default
  } catch {
    return null
  }
})()

if (!projectId) {
  console.error('archive-backup: could not read project id from .firebaserc')
  process.exit(1)
}

const backupRoot = path.join(
  os.homedir(),
  'Backups',
  'tosijs-platform',
  projectId
)

/** Newest COMPLETE snapshot — partials must never be the thing you restore. */
const newestSnapshot = () => {
  if (!fs.existsSync(backupRoot)) return null
  const dirs = fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse()
  for (const d of dirs) {
    const manifestPath = path.join(backupRoot, d, 'manifest.json')
    if (!fs.existsSync(manifestPath)) continue
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      if (m.complete) return d
    } catch {
      /* unreadable manifest — skip, same as the pruner */
    }
  }
  return null
}

/**
 * Where to put archives. Auto-detects the two macOS sync folders; `--to` adds
 * explicit ones and suppresses auto-detection, so a scripted run is never
 * surprised by a newly-installed Drive client.
 */
const destinations = () => {
  const explicit = all('to')
  if (explicit.length) return explicit.map((d) => d.replace(/^~/, os.homedir()))
  const candidates = [
    path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs'),
    ...(fs.existsSync(path.join(os.homedir(), 'Library', 'CloudStorage'))
      ? fs
          .readdirSync(path.join(os.homedir(), 'Library', 'CloudStorage'))
          .filter((n) => /^GoogleDrive-/.test(n))
          .map((n) => path.join(os.homedir(), 'Library', 'CloudStorage', n, 'My Drive'))
      : []),
  ]
  return candidates.filter((d) => fs.existsSync(d))
}

const snapshot = newestSnapshot()
if (!snapshot) {
  console.error(
    `archive-backup: no complete snapshot under ${backupRoot}. Run: bun run backup`
  )
  process.exit(1)
}

const dests = destinations()
if (!dests.length) {
  console.error(
    'archive-backup: no destination found.\n' +
      '  Expected iCloud Drive or a GoogleDrive-* folder under ~/Library/CloudStorage,\n' +
      '  or pass --to <dir>.'
  )
  process.exit(1)
}

const archiveName = `${projectId}-${snapshot}.tar.gz`
const staging = path.join(backupRoot, archiveName)

log(`snapshot    ${snapshot}`)
log(`roles       ${INCLUDE_ROLES ? 'INCLUDED (contact details leave this machine)' : 'excluded (contact details stay local)'}`)
log(`destinations ${dests.length}:`)
for (const d of dests) log(`  ${d}`)

if (!DRY) {
  // `tar` from the backup root so the archive contains `<snapshot>/…` and
  // unpacks into a predictable directory rather than spraying the cwd.
  const tarArgs = ['-czf', staging, '-C', backupRoot]
  if (!INCLUDE_ROLES) tarArgs.push('--exclude', path.join(snapshot, 'role'))
  tarArgs.push(snapshot)
  execFileSync('tar', tarArgs)
  fs.chmodSync(staging, 0o600)
}

const size = DRY
  ? 0
  : fs.statSync(staging).size
log(
  DRY
    ? `  [dry-run] would create ${archiveName}`
    : `  created ${archiveName} (${(size / 1024 / 1024).toFixed(1)} MB)`
)

let copied = 0
for (const dest of dests) {
  const dir = path.join(dest, 'tosijs-platform-backups', projectId)
  const target = path.join(dir, archiveName)
  if (DRY) {
    log(`  [dry-run] -> ${target}`)
    continue
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.copyFileSync(staging, target)
    fs.chmodSync(target, 0o600)
    copied++
    log(`  -> ${target}`)

    // Prune this destination. Only ever touches files matching THIS project's
    // archive pattern, so nothing else in the folder is at risk.
    const mine = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${projectId}-`) && f.endsWith('.tar.gz'))
      .sort()
    const excess = mine.slice(0, Math.max(0, mine.length - KEEP))
    for (const f of excess) {
      fs.unlinkSync(path.join(dir, f))
      console.error(`  pruned ${path.join(dir, f)}`)
    }
  } catch (e) {
    console.error(`  FAILED -> ${target}: ${e.message}`)
  }
}

/**
 * Mirror the content-addressed blob store — copy-once, never re-tarred.
 *
 * Storage objects are ~164 MB and essentially immutable. Putting them inside the
 * nightly tarball would ship 164 MB to every destination every night to protect
 * data that does not change; keeping 30 nights would be ~5 GB per cloud.
 *
 * Because `backup-storage.js` keys blobs by content hash, mirroring is just
 * "copy the files that are not there yet": each unique image crosses the wire
 * ONCE, ever, however many snapshots reference it. The snapshot's `storage.json`
 * manifest rides in the tarball (it lives in the snapshot directory) and is what
 * maps names back onto these blobs.
 *
 * Deliberately NOT pruned here. A blob is only safe to delete once no surviving
 * manifest mentions it, and the destination does not hold every manifest — that
 * decision belongs to `backup-storage.js --gc`, locally, where it can see them
 * all.
 */
const mirrorBlobs = () => {
  const localObjects = path.join(backupRoot, 'storage', 'objects')
  if (!fs.existsSync(localObjects)) return
  for (const dest of dests) {
    const destObjects = path.join(
      dest,
      'tosijs-platform-backups',
      projectId,
      'storage-objects'
    )
    let sent = 0
    let bytes = 0
    let present = 0
    for (const prefix of fs.readdirSync(localObjects)) {
      const srcDir = path.join(localObjects, prefix)
      const dstDir = path.join(destObjects, prefix)
      for (const hex of fs.readdirSync(srcDir)) {
        const src = path.join(srcDir, hex)
        const dst = path.join(dstDir, hex)
        if (fs.existsSync(dst)) {
          present++
          continue
        }
        bytes += fs.statSync(src).size
        sent++
        if (DRY) continue
        fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 })
        fs.copyFileSync(src, dst)
        fs.chmodSync(dst, 0o600)
      }
    }
    log(
      `  blobs -> ${destObjects}: ` +
        `${DRY ? '[dry-run] ' : ''}${sent} new (${(bytes / 1048576).toFixed(1)} MB), ` +
        `${present} already there`
    )
  }
}

mirrorBlobs()

if (!DRY) {
  fs.unlinkSync(staging)
  if (copied === 0) {
    console.error('archive-backup: no destination accepted the archive')
    process.exit(1)
  }
}

log(
  DRY
    ? '\nDRY RUN — nothing written.'
    : `\nArchived ${snapshot} to ${copied} destination(s).`
)
