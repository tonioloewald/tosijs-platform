#!/usr/bin/env bun
/**
 * Copy the legacy `blog/` files into the `blog:public` storage area (board
 * #2486, blob story step 4; plan agreed 2026-10-04).
 *
 *   bun scripts/migrate-blog-files.js --alias sandbox            # PLAN only (default)
 *   bun scripts/migrate-blog-files.js --alias sandbox --apply
 *   bun scripts/migrate-blog-files.js --alias default --apply    # production: asks for an agent token in the browser
 *
 * What it does:
 * - COPIES each file (server-side, `/blob` op `import`): the originals stay
 *   where they are, so every existing link keeps working. Nothing is deleted,
 *   and no post content is rewritten.
 * - gives each file a CLEAN name (`Character Sheet.pdf` → `Character-Sheet.pdf`);
 *   refuses to run if two files would land on one name.
 * - SKIPS files over the area's limit and reports them: large public files
 *   belong on the static-assets CDN (owner decision).
 * - is safe to re-run: a file already imported with the same bytes is `unchanged`.
 *
 * Who it runs as: on a sandbox, a throwaway author; on production, an AGENT
 * token you approve in the browser (author, limited to `blog:public`) — so each
 * file's provenance records that this agent imported it.
 */
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import * as lib from './sandbox-lib.js'

const { has, val } = lib.parseArgs(process.argv)
const alias = val('alias')
if (!alias) {
  console.error('usage: bun scripts/migrate-blog-files.js --alias <host> [--apply] [--folder blog] [--area blog:public]')
  process.exit(2)
}
const projectId = lib.readRc().projects?.[alias]
if (!projectId) throw new Error(`no project for alias "${alias}"`)
const isProduction = projectId === lib.productionProjectId()
if (!isProduction && !has('i-own-this-host')) {
  const purpose = await lib.readHostPurpose(projectId)
  if (purpose !== 'platform-sandbox') {
    console.error(`Refusing to migrate files on ${projectId} (${purpose ?? 'unmarked'}). If it really is yours: --i-own-this-host`)
    process.exit(1)
  }
}

const folder = (val('folder') ?? 'blog').replace(/\/+$/, '')
const area = val('area') ?? 'blog:public'
const BASE = `https://us-central1-${projectId}.cloudfunctions.net`
const manifest = JSON.parse(fs.readFileSync(path.join(lib.projectRoot, 'manifests/blog.json'), 'utf-8'))
const maxBytes = manifest.collections?.[area]?.blob?.maxBytes ?? Infinity

const { cleanName } = lib

// ── what is there ────────────────────────────────────────────────────────
const bucket = await lib.defaultBucket(projectId)
const files = []
let pageToken = ''
do {
  const r = await lib.api(
    'GET',
    `https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=${encodeURIComponent(folder + '/')}&fields=items(name,size,contentType),nextPageToken${pageToken ? `&pageToken=${pageToken}` : ''}`
  )
  if (!r.ok) throw new Error(`cannot list ${bucket}/${folder}: ${r.status}`)
  for (const o of r.json.items ?? []) {
    const name = o.name.slice(folder.length + 1)
    if (!name || name.includes('/') || Number(o.size) === 0) continue // the folder placeholder, sub-folders
    files.push({ from: o.name, to: cleanName(name), renamed: cleanName(name) !== name, bytes: Number(o.size), type: o.contentType })
  }
  pageToken = r.json.nextPageToken ?? ''
} while (pageToken)

const byTarget = new Map()
for (const f of files) byTarget.set(f.to, [...(byTarget.get(f.to) ?? []), f.from])
const collisions = [...byTarget].filter(([, froms]) => froms.length > 1)
const tooLarge = files.filter((f) => f.bytes > maxBytes)
const todo = files.filter((f) => f.bytes <= maxBytes)

console.log(`${projectId}: ${files.length} file(s) in ${folder}/ (${Math.round(files.reduce((n, f) => n + f.bytes, 0) / 1e6)} MB) → ${area}`)
console.log(`  ${todo.length} to copy, ${files.filter((f) => f.renamed).length} get a clean name, ${tooLarge.length} too large (skipped)`)
for (const f of files.filter((x) => x.renamed)) console.log(`    rename  ${JSON.stringify(f.from.slice(folder.length + 1))} → ${f.to}`)
for (const f of tooLarge) console.log(`    skip    ${f.from} (${Math.round(f.bytes / 1e6)} MB > ${Math.round(maxBytes / 1e6)} MB): use the static-assets CDN`)
if (collisions.length) {
  for (const [to, froms] of collisions) console.error(`  COLLISION: ${froms.join(' and ')} both become ${to}`)
  console.error('Refusing to run: resolve the collisions first.')
  process.exit(1)
}
if (!has('apply')) {
  console.log('\nPLAN only. Nothing was copied. Re-run with --apply.')
  process.exit(0)
}

// ── who runs it ──────────────────────────────────────────────────────────
let token
let roleDoc
if (isProduction) {
  token = await lib.agentToken(lib.siteBase(projectId), {
    label: `migration × ${folder}/ → ${area}`,
    caveats: { roles: ['author'], collections: [area] },
    open: !has('no-open'),
  })
} else {
  const out = execSync(
    `bun ${path.join(lib.projectRoot, 'scripts/sandbox-token.js')} --alias ${alias} --role migrator --grant author --export`,
    { encoding: 'utf-8', cwd: lib.projectRoot }
  )
  token = out.match(/SANDBOX_ID_TOKEN=(\S+)/)[1]
  roleDoc = (out.match(/SANDBOX_ROLE_DOC=(\S+)/) ?? [])[1]
}

// ── copy ─────────────────────────────────────────────────────────────────
const tally = { imported: 0, unchanged: 0, failed: 0 }
const failures = []
try {
  for (const f of todo) {
    // Under the platform's rate limit (100 requests/minute per IP).
    await new Promise((r) => setTimeout(r, 700))
    const res = await fetch(`${BASE}/blob`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'import', from: f.from, to: { area, path: f.to } }),
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok && (body.status === 'imported' || body.status === 'unchanged')) {
      tally[body.status]++
      if (body.bytes !== f.bytes) failures.push(`${f.from}: imported ${body.bytes} bytes, expected ${f.bytes}`)
    } else {
      tally.failed++
      failures.push(`${f.from} → ${f.to}: ${res.status} ${body.error ?? ''} ${body.message ?? ''}`)
    }
  }
} finally {
  if (roleDoc) {
    await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${roleDoc}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${lib.token()}` },
    }).catch(() => {})
  }
}

console.log(`\n${projectId}: ${tally.imported} imported, ${tally.unchanged} unchanged, ${tally.failed} failed, ${tooLarge.length} skipped (too large).`)
for (const line of failures) console.error(`  ${line}`)
console.log('The originals are untouched.')
process.exit(failures.length ? 1 : 0)
