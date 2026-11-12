#!/usr/bin/env bun
/**
 * Deploy EVERYTHING a host needs, in the right order, then check it worked.
 *
 *   bun run deploy                    # this repo's own host (alias `default`)
 *   bun scripts/deploy.js --alias sandbox
 *   bun scripts/deploy.js --alias sandbox --dry-run
 *
 * ## Why one command
 *
 * `firebase deploy --only …` deploys what you name and silently leaves the
 * rest. 0.3.0 changed functions, `storage.rules` AND the hosting headers
 * together; deploying functions alone would have shipped `/blob` with the old
 * rules, which exposed private storage areas. So the default is the whole set:
 *
 *   1. point the checkout at the target (client config + CLI) and build both;
 *   2. Firestore rules and INDEXES first — sign-in needs the contacts index
 *      before the functions that query it (BETA.md);
 *   3. functions, storage rules and hosting together;
 *   4. put the checkout back on the project it was on;
 *   5. check, from outside: every endpoint runs OUR code (a CORS preflight
 *      answered by us, not Google's 401/403), the bucket root cannot be listed,
 *      and the site serves.
 *
 * `firebase deploy --only …` stays available for experts; this is the path
 * that cannot forget a piece.
 *
 * ## Whose host
 *
 * Refuses a host marked `consumer` (somebody else's — e.g. virta's) and an
 * unmarked host other than this repo's production, unless `--i-own-this-host`.
 */
import fs from 'fs'
import path from 'path'
import * as lib from './sandbox-lib.js'

const { has, val } = lib.parseArgs(process.argv)
const alias = val('alias') ?? 'default'
const dryRun = has('dry-run')
const platformOnly = has('platform')

const rc = lib.readRc()
const projectId = rc.projects?.[alias]
if (!projectId) {
  console.error(`No project for alias "${alias}" in .firebaserc`)
  process.exit(2)
}

// ── whose host is this? ─────────────────────────────────────────────────────
if (!has('i-own-this-host') && projectId !== lib.productionProjectId()) {
  const purpose = await lib.readHostPurpose(projectId)
  if (purpose !== 'platform-sandbox') {
    console.error(
      `\nRefusing to deploy to ${projectId} (${purpose ?? 'unmarked'}).\n` +
        (purpose === 'consumer'
          ? '  It is marked `consumer`: somebody else runs it and deploys it themselves.\n'
          : '  It carries no host marker, so it cannot be shown to be ours.\n') +
        '  If it really is yours: --i-own-this-host\n'
    )
    process.exit(1)
  }
}

// ── which checkout config are we on now (to restore it after)? ───────────────
const configNow = fs.readFileSync(path.join(lib.projectRoot, 'src/firebase-config.ts'), 'utf-8')
const previousProject = configNow.match(/PROJECT_ID = '([^']+)'/)?.[1]
const previousAlias = Object.entries(rc.projects ?? {}).find(([, p]) => p === previousProject)?.[0]

const step = (title) => console.log(`\n▸ ${title}`)
const run = (cmd, opts = {}) => lib.run(cmd, { dryRun, ...opts })

step(`Target: ${alias} → ${projectId}${platformOnly ? ' (platform functions only)' : ''}`)
run(`bun scripts/use-project.js ${alias}`)
let failed = false
try {
  step('Build client and functions')
  run('bun run build')
  run('npm run build', { cwd: path.join(lib.projectRoot, 'functions') })

  step('Firestore rules and indexes (first: sign-in needs the contacts index)')
  run(`${lib.FIREBASE} deploy -P ${alias} --only firestore --force`)

  step('Functions, storage rules, hosting')
  const functions = platformOnly
    ? lib.PLATFORM_FUNCTIONS.map((f) => `functions:${f}`).join(',')
    : 'functions'
  run(`${lib.FIREBASE} deploy -P ${alias} --only ${functions},storage,hosting --force`)
} catch (e) {
  failed = true
  console.error(`\nDeploy failed: ${e.message}`)
} finally {
  if (previousAlias && previousAlias !== alias) {
    step(`Putting the checkout back on ${previousAlias}`)
    run(`bun scripts/use-project.js ${previousAlias}`)
    run('bun run build') // so dist/ matches the checkout again
  }
}
if (failed) process.exit(1)
if (dryRun) {
  console.log('\n(dry run — nothing deployed, nothing checked)')
  process.exit(0)
}

// ── check it from outside ────────────────────────────────────────────────────
step('Checking the deployed host')
const base = `https://us-central1-${projectId}.cloudfunctions.net`
const names = platformOnly ? lib.PLATFORM_FUNCTIONS : [...lib.PLATFORM_FUNCTIONS, ...lib.SITE_FUNCTIONS]
const problems = []
for (const name of names) {
  const r = await fetch(`${base}/${name}`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://deploy-check.test', 'Access-Control-Request-Method': 'GET' },
  }).catch((e) => ({ status: 0, headers: new Headers(), error: e }))
  const ours = r.headers.get('access-control-allow-origin') !== null
  console.log(`   ${ours ? 'ok ' : 'BAD'} ${name.padEnd(13)} ${r.status}${ours ? '' : ' — not answered by our code (invoker? not deployed?)'}`)
  if (!ours) problems.push(`${name}: ${r.status}`)
}

// An answer is not proof the new code is serving: when a new revision fails
// to start (a missing dependency, say), traffic stays on the old one, which
// still answers. A redeploy of the same source then skips the function as
// unchanged, and only this shows it.
let stuck = 0
for (const name of names) {
  const r = await lib
    .api('GET', `https://run.googleapis.com/v2/projects/${projectId}/locations/us-central1/services/${name.toLowerCase()}`)
    .catch((e) => ({ ok: false, status: 0, json: { error: String(e) } }))
  const { latestReadyRevision: ready, latestCreatedRevision: created } = r.json ?? {}
  if (!r.ok || !ready || ready !== created) {
    stuck++
    const why = r.ok ? `serving ${ready?.split('/').pop()}, newest ${created?.split('/').pop()} never became ready` : `status ${r.status}`
    console.log(`   BAD ${name.padEnd(13)} ${why}`)
    problems.push(`${name}: ${why}`)
  }
}
if (!stuck) console.log(`   ok  all ${names.length} functions serve their newest revision`)

const configFile = path.join(lib.projectRoot, `src/firebase-config.${alias}.ts`)
const bucket = fs.existsSync(configFile)
  ? fs.readFileSync(configFile, 'utf-8').match(/storageBucket:\s*['`]([^'`]+)['`]/)?.[1]?.replace('${PROJECT_ID}', projectId)
  : null
if (bucket) {
  const r = await fetch(`https://firebasestorage.googleapis.com/v0/b/${bucket}/o?prefix=`)
  const ok = r.status === 403
  console.log(`   ${ok ? 'ok ' : 'BAD'} bucket root listing ${r.status}${ok ? ' (denied)' : ' — storage.rules not deployed?'}`)
  if (!ok) problems.push(`bucket root listing: ${r.status}`)
}

const site = await fetch(`https://${projectId}.web.app/`).catch(() => ({ status: 0 }))
console.log(`   ${site.status === 200 ? 'ok ' : 'BAD'} site ${site.status}`)
if (site.status !== 200) problems.push(`site: ${site.status}`)

// Render on store serves a post as readable HTML, not only as JSON for the
// client (#4063). Silent if it breaks: people see the app, fetchers see nothing.
const envFile = path.join(lib.projectRoot, `functions/.env.${projectId}`)
const renderOnStore = fs.existsSync(envFile) && /^RENDER_ON_STORE=true\s*$/m.test(fs.readFileSync(envFile, 'utf-8'))
if (renderOnStore) {
  const [newest] = await fetch(`${base}/docs?p=post&f=path,title&o=date(desc)&c=1`)
    .then((r) => r.json())
    .catch(() => [])
  const html = newest?.path ? await fetch(`https://${projectId}.web.app/blog/${newest.path}`).then((r) => r.text(), () => '') : ''
  const text = (html.split('<body>')[1] ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ')
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
  const visible = text.replace(/&(amp|lt|gt|quot|#39);/g, (e) => entities[e]).replace(/\s+/g, ' ').trim()
  const chars = visible.length
  // A real post can be short; its title and a paragraph's worth of text are the floor.
  const ok = chars >= 100 && Boolean(newest?.title) && visible.includes(String(newest.title).replace(/\s+/g, ' ').trim())
  console.log(`   ${ok ? 'ok ' : 'BAD'} post readable without JS: ${chars} characters${ok ? '' : ` (/blog/${newest?.path ?? '?'})`}`)
  if (!ok) problems.push(`post without JS: ${chars} characters`)
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}\n`)
  process.exit(1)
}
console.log('\nDeployed and checked.\n')
