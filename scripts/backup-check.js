#!/usr/bin/env bun

/**
 * Is the backup actually healthy? Answers the question a failing scheduled job
 * cannot answer for itself.
 *
 * `backup-run.js` notifies when a run FAILS. It cannot notify when a run never
 * happens — an agent that launchd stopped firing produces no failure, no log
 * line and no exit code, which is the failure mode that went unnoticed for a
 * day. This reads the status file and the snapshots on disk and says plainly
 * whether the backup is doing its job.
 *
 * Checks, in the order they would bite:
 *   1. has a run ever been recorded?
 *   2. did the LAST run fail?
 *   3. is the last SUCCESS stale?
 *   4. is the newest snapshot on disk stale? (independent of the status file,
 *      so a corrupt or hand-edited status cannot make things look fine)
 *   5. did the off-site archive keep up? (a local-only backup does not survive
 *      losing the machine, which is the whole point of the archive step)
 *
 * Exits 0 healthy, 1 otherwise, so it is usable in a chain or a prompt.
 *
 * Usage:
 *   bun run backup:check
 *   bun run backup:check --notify   # also raise a macOS notification if unhealthy
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

import { readStatus, notify, STALE_HOURS } from './backup-run.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const NOTIFY = process.argv.includes('--notify')

const projectId = JSON.parse(
  fs.readFileSync(path.join(projectRoot, '.firebaserc'), 'utf-8')
).projects?.default
const backupRoot = path.join(os.homedir(), 'Backups', 'tosijs-platform', projectId)

const hoursSince = (iso) => (Date.now() - Date.parse(iso)) / 36e5

const problems = []
const notes = []

// --- 1-3: what the status file says -----------------------------------------
const status = readStatus()
if (!status) {
  problems.push('no status file — backup-run.js has never completed a run')
} else {
  if (!status.ok) {
    const bad = (status.steps ?? []).find((s) => !s.ok)
    problems.push(
      `last run FAILED at "${bad?.step ?? '?'}": ${bad?.error ?? 'unknown'}`
    )
  }
  if (!status.lastSuccess) {
    problems.push('no successful run has ever been recorded')
  } else {
    const age = hoursSince(status.lastSuccess)
    if (age > STALE_HOURS) {
      problems.push(
        `last SUCCESS was ${age.toFixed(0)}h ago (threshold ${STALE_HOURS}h)`
      )
    } else {
      notes.push(`last success ${age.toFixed(1)}h ago`)
    }
  }
}

// --- 4: what is actually on disk --------------------------------------------
// Deliberately independent of the status file: if that file is stale, corrupt
// or hand-edited, the snapshots are the ground truth.
const snapshots = fs.existsSync(backupRoot)
  ? fs
      .readdirSync(backupRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(e.name))
      .map((e) => e.name)
      .sort()
  : []
const newest = snapshots[snapshots.length - 1]
if (!newest) {
  problems.push(`no snapshots under ${backupRoot}`)
} else {
  let takenAt = null
  try {
    takenAt = JSON.parse(
      fs.readFileSync(path.join(backupRoot, newest, 'manifest.json'), 'utf-8')
    ).takenAt
  } catch {
    problems.push(`newest snapshot ${newest} has no readable manifest`)
  }
  if (takenAt) {
    const age = hoursSince(takenAt)
    if (age > STALE_HOURS) {
      problems.push(`newest snapshot on disk is ${age.toFixed(0)}h old`)
    } else {
      notes.push(`${snapshots.length} snapshots, newest ${age.toFixed(1)}h old`)
    }
  }
}

// --- 5: did it leave the machine? -------------------------------------------
const destinations = [
  path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs'),
  ...(fs.existsSync(path.join(os.homedir(), 'Library', 'CloudStorage'))
    ? fs
        .readdirSync(path.join(os.homedir(), 'Library', 'CloudStorage'))
        .filter((n) => /^GoogleDrive-/.test(n))
        .map((n) => path.join(os.homedir(), 'Library', 'CloudStorage', n, 'My Drive'))
    : []),
].filter((d) => fs.existsSync(d))

let archivedAnywhere = false
for (const dest of destinations) {
  const dir = path.join(dest, 'tosijs-platform-backups', projectId)
  if (!fs.existsSync(dir)) continue
  const archives = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${projectId}-`) && f.endsWith('.tar.gz'))
    .sort()
  if (!archives.length) continue
  archivedAnywhere = true
  const age = hoursSince(
    fs.statSync(path.join(dir, archives[archives.length - 1])).mtime.toISOString()
  )
  const label = dest.includes('CloudDocs') ? 'iCloud' : 'Drive'
  if (age > STALE_HOURS) {
    problems.push(`${label} archive is ${age.toFixed(0)}h old`)
  } else {
    notes.push(`${label}: ${archives.length} archives, newest ${age.toFixed(1)}h`)
  }
}
if (destinations.length && !archivedAnywhere) {
  problems.push('no off-site archive found — backups are local-only')
}

// --- report ------------------------------------------------------------------
console.log(`backup check — ${projectId}`)
for (const n of notes) console.log(`  ok    ${n}`)
for (const p of problems) console.error(`  PROBLEM  ${p}`)

if (problems.length) {
  if (NOTIFY) {
    notify(`Backup unhealthy — ${projectId}`, problems[0].slice(0, 180))
  }
  console.error(
    `\n${problems.length} problem(s). The nightly agent is:\n` +
      '  launchctl list | grep tosijs      (second column is the last exit code)\n' +
      '  bun run backup:install            (re-install if it is missing)\n'
  )
  process.exit(1)
}

console.log('\nhealthy')
