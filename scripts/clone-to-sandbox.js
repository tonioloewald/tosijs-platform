#!/usr/bin/env bun

/**
 * Clone a representative subset of production into a sandbox project.
 *
 * The goal this serves: stand up a working loewald.com on a blank project and
 * verify it end to end. That is both the acceptance test for the platform and
 * — once the blog becomes an installed manifest — the ORACLE for that
 * conversion: re-run the same verification and the answer must be identical.
 *
 * ## Representative, not random
 *
 * 849 posts is more than a sandbox needs and less varied than it looks. The
 * sample is chosen to cover the shapes that actually break things:
 *
 *   - published AND unpublished (58 of 849 are drafts, and drafts being
 *     list-visible was a real leak)
 *   - the one post with no `date` field at all
 *   - posts carrying `format` (only 56 of 849 do)
 *   - posts with empty vs populated `keywords`
 *   - oldest and newest by `_created`, plus a spread between
 *   - Appwrite-residue and clean posts, since the repair must handle both
 *
 * Coverage is asserted, not hoped for: if a bucket cannot be filled the script
 * says so rather than silently shipping a thinner sample.
 *
 * ## Repaired on the way in
 *
 * Documents are passed through the SAME `planRepair`/`applyPlan` the production
 * migration uses, so the sandbox holds the intended end state and every cloned
 * document passes its schema. `--raw` clones the legacy shape instead, which is
 * what you want to rehearse the migration itself.
 *
 * ## No ADC, and no copied PII
 *
 * Writes go through the Firestore REST API with a `gcloud auth print-access-token`
 * token — the same transport `backup-firestore.js` falls back to — so this needs
 * no application-default credentials.
 *
 * **Role documents are never copied.** They hold real contact details (email,
 * phone, mailing address) for real people, and a throwaway project is the last
 * place those belong. Instead a single fresh `role` document is generated for
 * the CURRENT gcloud account, granting it owner on the sandbox only.
 *
 * ## Safety
 *
 * - DRY RUN BY DEFAULT; `--apply` required.
 * - Target resolved through `resolveSandbox()` — alias only, never a raw
 *   project id, and production is refused four different ways.
 * - Reads a local backup; never reads production directly.
 *
 * Usage:
 *   bun scripts/clone-to-sandbox.js                    # dry run
 *   bun scripts/clone-to-sandbox.js --apply
 *   bun scripts/clone-to-sandbox.js --apply --posts 60
 *   bun scripts/clone-to-sandbox.js --apply --raw      # keep legacy residue
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import {
  resolveSandbox,
  productionProjectId,
  homeBackupRoot,
  token,
  parseArgs,
} from './sandbox-lib.js'
import { planRepair, applyPlan } from './migrate-schema-residue.js'

const { has, val } = parseArgs(process.argv)
const APPLY = has('apply')
const RAW = has('raw')
const ALIAS = val('alias') ?? 'sandbox'
const POST_COUNT = Number(val('posts') ?? 30)
const dry = !APPLY

const ENVELOPE = ['_id', '_collection', '_path']

/** Mirrors decode() in restore-firestore.js. */
const decode = (v) => {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(decode)
  if (typeof v.__type === 'string') return v.value
  const o = {}
  for (const [k, x] of Object.entries(v)) o[k] = decode(x)
  return o
}

/** JS value -> Firestore REST typed value. */
export function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { integerValue: String(v) }
      : { doubleValue: v }
  }
  if (typeof v === 'string') return { stringValue: v }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFirestoreValue) } }
  }
  if (typeof v === 'object') {
    const fields = {}
    for (const [k, x] of Object.entries(v)) fields[k] = toFirestoreValue(x)
    return { mapValue: { fields } }
  }
  throw new Error(`cannot encode ${typeof v}`)
}

export const toFirestoreFields = (doc) => {
  const fields = {}
  for (const [k, v] of Object.entries(doc)) fields[k] = toFirestoreValue(v)
  return fields
}

const latestSnapshot = (projectId) => {
  const root = homeBackupRoot(projectId)
  if (!fs.existsSync(root)) return null
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        /^\d{4}-\d{2}-\d{2}T/.test(e.name) &&
        fs.existsSync(path.join(root, e.name, 'manifest.json'))
    )
    .map((e) => e.name)
    .sort()
  return dirs.length ? path.join(root, dirs[dirs.length - 1]) : null
}

const loadCollection = (snapshot, collection) => {
  const dir = path.join(snapshot, collection)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
      return { id: raw._id, data: decode(raw.data) }
    })
}

const isPublished = (d) => String(d.date ?? '').trim() !== ''
const hasResidue = (d) => '$id' in d || 'id' in d || '$createdAt' in d

/**
 * Pick a representative subset. Buckets first (each guaranteed a slot), then
 * fill the remainder with a spread across `_created` so the sample is not all
 * from one era.
 */
export function selectPosts(posts, count) {
  const chosen = new Map()
  const take = (label, predicate, n = 1) => {
    const found = posts.filter((p) => !chosen.has(p.id) && predicate(p.data))
    for (const p of found.slice(0, n)) chosen.set(p.id, p)
    return { label, wanted: n, got: Math.min(n, found.length) }
  }

  const coverage = [
    take('published', (d) => isPublished(d), 3),
    take('unpublished (draft)', (d) => !isPublished(d), 3),
    take('no `date` field at all', (d) => !('date' in d)),
    take('has `format`', (d) => 'format' in d, 2),
    take('empty keywords', (d) => Array.isArray(d.keywords) && !d.keywords.length, 2),
    take('populated keywords', (d) => Array.isArray(d.keywords) && d.keywords.length > 0, 2),
    take('appwrite residue', (d) => hasResidue(d), 3),
    take('clean (no residue)', (d) => !hasResidue(d), 3),
  ]

  const byCreated = [...posts].sort((a, b) =>
    String(a.data._created).localeCompare(String(b.data._created))
  )
  if (byCreated.length) {
    chosen.set(byCreated[0].id, byCreated[0])
    chosen.set(byCreated[byCreated.length - 1].id, byCreated[byCreated.length - 1])
  }

  // Spread the remainder evenly across the timeline rather than taking a block.
  const remaining = byCreated.filter((p) => !chosen.has(p.id))
  const need = Math.max(0, count - chosen.size)
  const stride = Math.max(1, Math.floor(remaining.length / Math.max(1, need)))
  for (let i = 0; i < remaining.length && chosen.size < count; i += stride) {
    chosen.set(remaining[i].id, remaining[i])
  }

  return { posts: [...chosen.values()], coverage }
}

const prepare = (collection, data) => {
  if (RAW) return data
  const plan = planRepair(collection, data)
  const out = plan ? applyPlan(data, plan) : { ...data }
  for (const k of ENVELOPE) delete out[k]
  return out
}

async function writeDoc(projectId, tok, collection, id, data) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
    `/databases/(default)/documents/${collection}/${encodeURIComponent(id)}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${tok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  })
  if (!res.ok) {
    throw new Error(`${collection}/${id}: ${res.status} ${await res.text()}`)
  }
}

async function main() {
  const { projectId } = resolveSandbox(ALIAS)
  const prod = productionProjectId()
  const snapshot = latestSnapshot(prod)
  if (!snapshot) {
    throw new Error(
      `No backup snapshot for ${prod}. Run: bun run backup`
    )
  }

  console.log(
    `\n${dry ? 'DRY RUN' : 'APPLYING'} — clone into "${ALIAS}" (${projectId})`
  )
  console.log(`Source: ${snapshot} (local backup, production not touched)`)
  console.log(`Mode:   ${RAW ? 'RAW (legacy residue kept)' : 'REPAIRED'}\n`)

  const allPosts = loadCollection(snapshot, 'post')
  const { posts, coverage } = selectPosts(allPosts, POST_COUNT)

  console.log(`posts: ${posts.length} of ${allPosts.length}`)
  for (const c of coverage) {
    const ok = c.got >= c.wanted ? ' ' : '!'
    console.log(`  ${ok} ${c.label}: ${c.got}/${c.wanted}`)
  }
  const short = coverage.filter((c) => c.got < c.wanted)
  if (short.length) {
    console.log(
      `  NOTE: ${short.length} bucket(s) under-filled — the corpus lacks those shapes.`
    )
  }

  const work = [['post', posts]]
  for (const c of ['page', 'module', 'config']) {
    const docs = loadCollection(snapshot, c)
    console.log(`${c}: ${docs.length}`)
    work.push([c, docs])
  }

  // Role: generated, never copied. See the header.
  const account = execSync('gcloud config get-value account', {
    encoding: 'utf-8',
  }).trim()
  const now = new Date().toISOString()
  const roleDoc = {
    name: 'Sandbox Owner',
    contacts: [{ type: 'email', value: account }],
    roles: ['owner'],
    userIds: [],
    _created: now,
    _modified: now,
  }
  console.log(`role: 1 GENERATED for ${account} (production roles never copied)`)
  work.push([
    'role',
    [{ id: 'sandbox-owner', data: roleDoc, generated: true }],
  ])

  const total = work.reduce((n, [, d]) => n + d.length, 0)
  if (dry) {
    console.log(`\nDRY RUN — would write ${total} documents. Re-run with --apply.`)
    return
  }

  const tok = token()
  let written = 0
  for (const [collection, docs] of work) {
    for (const d of docs) {
      const data = d.generated ? d.data : prepare(collection, d.data)
      await writeDoc(projectId, tok, collection, d.id, data)
      written++
    }
    console.log(`  wrote ${collection}: ${docs.length}`)
  }
  console.log(`\nCloned ${written} documents into ${projectId}.`)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`\nclone-to-sandbox failed: ${e.message}`)
    process.exit(1)
  })
}
