#!/usr/bin/env bun
/**
 * Move the blog's posts and pages from `post` and `page` to `blog:post` and
 * `blog:page` (D28): the collections the blog manifest (1.1.0 and later)
 * installs, now that they are the blog's and not the platform's.
 *
 *   bun scripts/migrate-blog-collections.js --alias sandbox                  # what would be copied
 *   bun scripts/migrate-blog-collections.js --alias sandbox --apply
 *   bun scripts/migrate-blog-collections.js --alias default --production --apply
 *   bun scripts/migrate-blog-collections.js --alias default --production --check
 *   bun scripts/migrate-blog-collections.js --alias default --production --retire
 *   bun scripts/migrate-blog-collections.js --emulator --apply
 *
 * ## What it does
 *
 *   - Copies every document under the same id, its fields exactly as stored
 *     (raw Firestore values, so nothing changes type on the way). The one
 *     rewrite: a page's `prefetch` patterns name the new collections
 *     (production's blog page names `post/path=[3]`).
 *   - Clears `config/blog-cache`, which holds posts under their old paths, so
 *     no editor re-opens a cached post and saves it to the old collection.
 *   - NEVER deletes. `post` and `page` stay as they are, as the rollback, until
 *     someone removes them deliberately.
 *
 * It is safe to run again, and meant to be: a post edited in the old
 * collection after a copy is copied again, one edited in the new collection is
 * kept, and anything else already copied is left alone (blog-collections-lib.js).
 * Every write has a precondition (create only if absent, update only if not
 * changed since read), so a concurrent edit makes the batch fail rather than
 * be overwritten; run it again.
 *
 * ## Safety
 *
 *   - DRY RUN by default. `--apply` writes; production also needs `--production`.
 *   - Refuses a host whose blog manifest is older than 1.1.0: there would be no
 *     rules for the documents it copies.
 *   - Refuses a host that is neither this repo's production nor a marked
 *     platform sandbox (as deploy.js does), unless `--i-own-this-host`.
 *   - `--check` exits 1 unless every document is in place: run it after the
 *     copy, and again after the deploy.
 *   - `--retire`, once the deployed site checks out: removes the registry's
 *     `post` and `page` rules (`system:registry/post`, `/page`), so the old
 *     collections stop being served and written. `seed-registry.js` never
 *     deletes, so without this they stay live, and every instance logs that
 *     they are served without being in the code. It refuses unless `--check`
 *     would pass. The DATA stays; rolling back is the previous code plus
 *     `seed-registry.js --apply` from it, which restores the two rules.
 *
 * Its order in a cutover (each production step needs the owner's go-ahead):
 * `bun run backup`; install the blog manifest 1.1.0; this, `--apply`;
 * `bun run deploy`; this again, `--check`.
 */
import * as lib from './sandbox-lib.js'
import { MOVES, atLeast, planIsComplete, planMove, transformFor } from './blog-collections-lib.js'

const MANIFEST_FLOOR = '1.1.0'
const BATCH = 400

const { has, val } = lib.parseArgs(process.argv)
const EMULATOR = has('emulator')
const alias = val('alias') ?? (EMULATOR ? 'default' : undefined)
const projectId = alias ? lib.readRc().projects?.[alias] : null
if (!projectId) {
  console.error('usage: bun scripts/migrate-blog-collections.js --alias <alias> [--apply] [--check] [--production] | --emulator [--apply]')
  process.exit(2)
}
const isProduction = !EMULATOR && projectId === lib.productionProjectId()
if (isProduction && !has('production')) {
  console.error(`Refusing: "${alias}" is PRODUCTION (${projectId}). Add --production to confirm.`)
  process.exit(2)
}
if (!EMULATOR && !isProduction && !has('i-own-this-host')) {
  const purpose = await lib.readHostPurpose(projectId)
  if (purpose !== 'platform-sandbox') {
    console.error(`Refusing: ${projectId} is ${purpose ?? 'unmarked'}, not this repo's production or a platform sandbox.`)
    process.exit(2)
  }
}

const API = EMULATOR ? 'http://127.0.0.1:8080/v1' : 'https://firestore.googleapis.com/v1'
const root = `projects/${projectId}/databases/(default)/documents`
const headers = { Authorization: `Bearer ${EMULATOR ? 'owner' : lib.token()}`, 'Content-Type': 'application/json' }
const segment = (path) => path.split('/').map(encodeURIComponent).join('/')

async function getDoc(path) {
  const res = await fetch(`${API}/${root}/${segment(path)}`, { headers })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`read ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

/** Every document of a collection: id → { fields, updateTime }. */
async function listAll(collection) {
  const out = new Map()
  let pageToken
  do {
    const url = new URL(`${API}/${root}/${encodeURIComponent(collection)}`)
    url.searchParams.set('pageSize', '300')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url, { headers })
    if (!res.ok && res.status !== 404) throw new Error(`list ${collection}: ${res.status} ${await res.text()}`)
    const body = res.ok ? await res.json() : {}
    for (const d of body.documents ?? []) {
      out.set(d.name.split('/').pop(), { fields: d.fields ?? {}, updateTime: d.updateTime })
    }
    pageToken = body.nextPageToken
  } while (pageToken)
  return out
}

console.log(
  `\nmigrate-blog-collections → ${projectId}${EMULATOR ? '  (EMULATOR)' : isProduction ? '  (PRODUCTION)' : ''}` +
    `  ${has('retire') ? 'RETIRE' : ''}${has('apply') ? ' APPLY' : has('check') ? ' CHECK' : ' DRY RUN'}\n`
)

const grant = await getDoc('grant/blog')
const installed = grant?.fields?.activeVersion?.stringValue
if (!atLeast(installed, MANIFEST_FLOOR)) {
  console.error(
    `Refusing: the blog manifest here is ${installed ?? 'not installed'}; blog:post and blog:page need ${MANIFEST_FLOOR} or later.\n` +
      `  Install it first: bun scripts/install-manifest.js manifests/blog.json ${isProduction ? '--production' : `--alias ${alias}`}`
  )
  process.exit(1)
}
console.log(`   blog manifest ${installed}`)

const writes = []
let complete = true
for (const { from, to } of MOVES) {
  const [source, target] = await Promise.all([listAll(from), listAll(to)])
  const plan = planMove(source, target, transformFor(from))
  complete &&= planIsComplete(plan)
  console.log(
    `   ${from} → ${to}: ${source.size} to move; ` +
      `${plan.create.length} to create, ${plan.update.length} to update, ${plan.unchanged.length} unchanged, ` +
      `${plan.kept.length} edited since the move (kept), ${plan.onlyInTarget.length} new since the move` +
      (plan.conflict.length ? `, ${plan.conflict.length} CONFLICT: ${plan.conflict.join(', ')}` : '')
  )
  for (const { id, fields } of plan.create) {
    writes.push({ update: { name: `${root}/${to}/${id}`, fields }, currentDocument: { exists: false } })
  }
  for (const { id, fields, updateTime } of plan.update) {
    writes.push({ update: { name: `${root}/${to}/${id}`, fields }, currentDocument: { updateTime } })
  }
}

if (has('retire')) {
  if (!complete) {
    console.error('\nRefusing to retire post and page: not every document is in blog:post and blog:page yet.')
    process.exit(1)
  }
  const registry = 'system:registry'
  const present = []
  for (const { from } of MOVES) if (await getDoc(`${registry}/${from}`)) present.push(from)
  if (!present.length) {
    console.log('\npost and page are already retired: the registry has no rules for them')
    process.exit(0)
  }
  if (!has('apply')) {
    console.log(`\nDRY RUN: would remove ${present.map((n) => `${registry}/${n}`).join(' and ')}, and bump the epoch. Add --apply.`)
    process.exit(0)
  }
  // One commit: the deletes and the epoch bump, so every instance reloads
  // onto the new rules together (as seed-registry.js does).
  const res = await fetch(`${API}/${root}:commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      writes: [
        ...present.map((n) => ({ delete: `${root}/${registry}/${n}` })),
        {
          update: { name: `${root}/${registry}/epoch`, fields: { at: { stringValue: new Date().toJSON() } } },
          updateMask: { fieldPaths: ['at'] },
          updateTransforms: [{ fieldPath: 'value', increment: { integerValue: '1' } }],
        },
      ],
    }),
  })
  if (!res.ok) {
    console.error(`\nCOMMIT FAILED (${res.status}); nothing was removed:\n${await res.text()}`)
    process.exit(1)
  }
  console.log(`\nretired ${present.join(' and ')}: their rules are gone from the registry; their documents remain`)
  process.exit(0)
}

if (has('check')) {
  console.log(complete ? '\nCHECK OK: every post and page is in blog:post and blog:page' : '\nCHECK FAILED: run with --apply (and resolve any CONFLICT by hand)')
  process.exit(complete ? 0 : 1)
}
if (!has('apply')) {
  console.log(`\nDRY RUN: ${writes.length} document(s) would be written, and config/blog-cache cleared. Re-run with --apply.`)
  process.exit(0)
}

// The cache holds posts under their old paths: clear it, as saving a post does.
writes.push({
  update: { name: `${root}/config/blog-cache`, fields: { cleared: { stringValue: new Date().toJSON() } } },
})

let written = 0
for (let i = 0; i < writes.length; i += BATCH) {
  const batch = writes.slice(i, i + BATCH)
  const res = await fetch(`${API}/${root}:commit`, { method: 'POST', headers, body: JSON.stringify({ writes: batch }) })
  if (!res.ok) {
    console.error(
      `\nCOMMIT FAILED (${res.status}) after ${written} document(s); this batch wrote nothing.\n` +
        `Running it again is safe.\n${await res.text()}`
    )
    process.exit(1)
  }
  written += batch.length
}
console.log(`\nwrote ${written - 1} document(s) and cleared config/blog-cache. Check: --check`)
