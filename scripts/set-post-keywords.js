#!/usr/bin/env bun

/**
 * Set posts' `keywords` from a reviewed plan file: a metadata backfill.
 *
 *   bun scripts/set-post-keywords.js <plan.json>                 # dry run (default)
 *   bun scripts/set-post-keywords.js <plan.json> --apply         # write production
 *   bun scripts/set-post-keywords.js <plan.json> --alias sandbox --apply
 *
 * The plan is a JSON array of `{ id, title, before, keywords }`: `before` is
 * the keywords the plan was made from, `keywords` what to store.
 *
 * ## Why Firestore directly, not /doc
 *
 * For the reason migrate-schema-residue.js gives: `/doc` would re-stamp
 * `_modified` on every post, marking years-old posts as edited today, and
 * `_modified` feeds the sitemap's lastmod and the drafts list's order. Only the
 * `keywords` field is written (an update mask); `_modified` and `_by` stay.
 *
 * That bypasses the write pipeline, so the script holds itself to its rules:
 * keywords are a non-empty array of lowercase, trimmed, distinct strings (the
 * post schema's `keywords` is an array of strings), and a post is written only
 * if its stored keywords still equal the plan's `before`, with the read's
 * update time as a precondition, so an edit made since the plan was drawn up is
 * never overwritten.
 *
 * ## Safety
 *
 * - DRY RUN by default; `--apply` writes.
 * - Production refuses to run without a backup snapshot under 24h old.
 * - Afterwards the blog cache (`config/blog-cache`) is cleared, as a post write
 *   through /doc would; the render store's blog index refreshes on its own
 *   schedule or with `bun scripts/render-store.js purge`.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readRc, productionProjectId, api, parseArgs } from './sandbox-lib.js'

const { has, val, args } = parseArgs(process.argv)
const planFile = args.find((a) => !a.startsWith('--') && a.endsWith('.json'))
if (!planFile) {
  console.error('usage: set-post-keywords.js <plan.json> [--alias sandbox] [--apply]')
  process.exit(2)
}
const alias = val('alias') ?? 'default'
const projectId = readRc().projects?.[alias]
if (!projectId) throw new Error(`no project for alias ${alias}`)
const apply = has('apply')
const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`

function assertRecentBackup() {
  const root = path.join(os.homedir(), 'Backups', 'tosijs-platform', projectId)
  const snaps = fs.existsSync(root)
    ? fs.readdirSync(root).filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n) && fs.existsSync(path.join(root, n, 'manifest.json'))).sort()
    : []
  const newest = snaps[snaps.length - 1]
  if (!newest) throw new Error(`No complete snapshot under ${root}. Run: bun run backup`)
  const takenAt = new Date(JSON.parse(fs.readFileSync(path.join(root, newest, 'manifest.json'), 'utf-8')).takenAt)
  const ageHours = (Date.now() - takenAt.getTime()) / 36e5
  if (ageHours > 24) throw new Error(`Newest backup is ${ageHours.toFixed(1)}h old (${newest}). Run: bun run backup`)
  console.log(`Backup: ${newest} (${ageHours.toFixed(1)}h old)`)
}

const wellFormed = (keywords) =>
  Array.isArray(keywords) &&
  keywords.length > 0 &&
  keywords.every((k) => typeof k === 'string' && k === k.trim().toLowerCase() && k !== '') &&
  new Set(keywords).size === keywords.length

const storedKeywords = (doc) => (doc.fields?.keywords?.arrayValue?.values ?? []).map((v) => v.stringValue)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

if (projectId === productionProjectId()) assertRecentBackup()
const plan = JSON.parse(fs.readFileSync(planFile, 'utf-8'))
console.log(`${apply ? 'APPLY' : 'DRY RUN'} → ${projectId}: ${plan.length} plan entries\n`)

const counts = { written: 0, unchanged: 0, skipped: 0 }
for (const entry of plan) {
  const label = `post/${entry.id} ${String(entry.title).slice(0, 60)}`
  if (!wellFormed(entry.keywords)) {
    console.log(`   SKIP ${label}: malformed keywords`)
    counts.skipped++
    continue
  }
  const read = await api('GET', `${base}/post/${entry.id}`)
  if (!read.ok) {
    console.log(`   SKIP ${label}: read ${read.status}`)
    counts.skipped++
    continue
  }
  const stored = storedKeywords(read.json)
  if (same(stored, entry.keywords)) {
    counts.unchanged++
    continue
  }
  if (!same(stored, entry.before ?? [])) {
    console.log(`   SKIP ${label}: keywords changed since the plan was made`)
    counts.skipped++
    continue
  }
  if (!apply) {
    console.log(`   would set ${label}: ${entry.keywords.join(', ')}`)
    counts.written++
    continue
  }
  const url =
    `${base}/post/${entry.id}?updateMask.fieldPaths=keywords` +
    `&currentDocument.updateTime=${encodeURIComponent(read.json.updateTime)}`
  const write = await api('PATCH', url, {
    fields: { keywords: { arrayValue: { values: entry.keywords.map((k) => ({ stringValue: k })) } } },
  })
  if (write.ok) {
    counts.written++
  } else {
    console.log(`   FAIL ${label}: ${write.status} ${JSON.stringify(write.json).slice(0, 200)}`)
    counts.skipped++
  }
}

if (apply && counts.written) {
  const clear = await api('PATCH', `${base}/config/blog-cache`, {
    fields: { cleared: { stringValue: new Date().toISOString() } },
  })
  console.log(`\nblog cache ${clear.ok ? 'cleared' : `NOT cleared (${clear.status})`}`)
}
console.log(
  `\n${apply ? 'written' : 'would write'} ${counts.written}, already set ${counts.unchanged}, skipped ${counts.skipped}`
)
if (counts.skipped) process.exit(1)
