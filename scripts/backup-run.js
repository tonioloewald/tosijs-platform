#!/usr/bin/env bun

/**
 * Run the whole nightly backup and MAKE FAILURE VISIBLE.
 *
 * ## Why this exists
 *
 * The nightly job failed for a day and nothing said so. launchd's only signal is
 * an exit code you have to go and ask for (`launchctl list`), and the log is a
 * file nobody opens. It worked perfectly by hand the entire time, which is
 * exactly why it went unnoticed.
 *
 * So the job now reports. On any step failing: a macOS notification, a status
 * file, and a non-zero exit.
 *
 * ## The hard part: a job that never runs cannot report that it never ran
 *
 * Notifying on failure only covers runs that happen. If launchd stops firing the
 * agent — unloaded, machine off, plist broken — there is nothing to fire a
 * notification. Two things cover that gap:
 *
 *   - every run compares against the last recorded success and shouts if there
 *     was a GAP, so a job that comes back after three dead days says so instead
 *     of quietly reporting success;
 *   - `bun run backup:check` reads the same status file and fails loudly when
 *     the last success is stale — runnable on demand, and cheap enough to wire
 *     into anything you already run.
 *
 * The status file is the contract between the two, and it is written on FAILURE
 * as well as success — a status file that only appears when things went well
 * tells you nothing on the day it matters.
 *
 * Usage:
 *   bun scripts/backup-run.js            # what the LaunchAgent runs
 *   bun scripts/backup-run.js --quiet
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const QUIET = args.includes('--quiet')
const log = (...a) => {
  if (!QUIET) console.log(...a)
}

const projectId = JSON.parse(
  fs.readFileSync(path.join(projectRoot, '.firebaserc'), 'utf-8')
).projects?.default

const backupRoot = path.join(os.homedir(), 'Backups', 'tosijs-platform', projectId)
export const statusPath = path.join(backupRoot, 'status.json')

/** Hours after which a successful run is considered overdue. */
export const STALE_HOURS = 36

export const readStatus = () => {
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * macOS notification. Best-effort by design: a notification that throws must
 * never be the reason a backup reports failure.
 */
export const notify = (title, message) => {
  try {
    spawnSync('osascript', [
      '-e',
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(
        title
      )} sound name "Basso"`,
    ])
  } catch {
    /* headless or no osascript — the status file and exit code still carry it */
  }
}

const STEPS = [
  { name: 'firestore', argv: ['scripts/backup-firestore.js', '--quiet', '--keep', '30'] },
  { name: 'storage', argv: ['scripts/backup-storage.js', '--quiet', '--gc'] },
  { name: 'archive', argv: ['scripts/archive-backup.js', '--quiet', '--keep', '30'] },
]

if (import.meta.main) {
  const previous = readStatus()
  const startedAt = new Date().toISOString()
  const results = []
  let failed = null

  for (const step of STEPS) {
    const began = Date.now()
    try {
      execFileSync(process.execPath, step.argv, {
        cwd: projectRoot,
        stdio: QUIET ? 'pipe' : 'inherit',
      })
      results.push({ step: step.name, ok: true, ms: Date.now() - began })
      log(`  ${step.name}: ok`)
    } catch (e) {
      // Chained deliberately: no snapshot means nothing to archive, and a second
      // failure would only obscure the first.
      const detail = (e.stderr?.toString() || e.message || '').trim().split('\n').slice(-3).join(' ')
      results.push({ step: step.name, ok: false, ms: Date.now() - began, error: detail })
      failed = { step: step.name, detail }
      break
    }
  }

  const status = {
    project: projectId,
    lastAttempt: startedAt,
    ok: !failed,
    steps: results,
    lastSuccess: failed ? previous?.lastSuccess ?? null : startedAt,
    lastFailure: failed ? startedAt : previous?.lastFailure ?? null,
  }
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 })
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), { mode: 0o600 })

  if (failed) {
    console.error(`BACKUP FAILED at step "${failed.step}": ${failed.detail}`)
    notify(
      `Backup FAILED — ${projectId}`,
      `step "${failed.step}": ${failed.detail.slice(0, 180)}`
    )
    process.exit(1)
  }

  // Succeeded — but did we miss runs before this one? A job that comes back
  // after a silent outage should say so rather than look like business as usual.
  if (previous?.lastSuccess) {
    const gapHours = (Date.parse(startedAt) - Date.parse(previous.lastSuccess)) / 36e5
    if (gapHours > STALE_HOURS) {
      const msg = `previous success was ${gapHours.toFixed(0)}h earlier — runs were missed`
      console.error(`WARNING: ${msg}`)
      notify(`Backup recovered — ${projectId}`, msg)
    }
  }

  log(`backup ok — ${results.map((r) => `${r.step} ${r.ms}ms`).join(', ')}`)
}
