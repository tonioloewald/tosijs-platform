#!/usr/bin/env bun
/**
 * Inspect and purge the render store (D23) — the operator's view the
 * adversarial review asked for. Reads and deletes with operator credentials
 * (Firestore REST + your gcloud token); never renders.
 *
 *   bun scripts/render-store.js --alias sandbox list [prefix]   # keys, freshness, age
 *   bun scripts/render-store.js --alias sandbox show <key>      # one value's deps and metadata
 *   bun scripts/render-store.js --alias sandbox dependents <dep> # which keys a dep would invalidate
 *   bun scripts/render-store.js --alias sandbox purge <key>|--all [--version r1] [--yes]
 *
 * `purge` deletes (the next read recomputes). `--version` targets an older
 * namespace's collection, e.g. to drop r1 after the bump to r2.
 */
import * as lib from './sandbox-lib.js'

const { has, val, args } = lib.parseArgs(process.argv)
const alias = val('alias') ?? 'default'
const projectId = lib.readRc().projects?.[alias]
if (!projectId) throw new Error(`no project for alias ${alias}`)
const version = val('version') ?? 'r2'
// 'legacy': the unversioned collection the first prototype used (2026-10-03).
const collection = version === 'legacy' ? 'system:render' : `system:render-${version}`
const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && ['--alias', '--version'].includes(args[i - 1])))
const [cmd, arg] = positional

const field = (f) => f?.stringValue ?? f?.booleanValue ?? f?.timestampValue ?? (f?.arrayValue ? (f.arrayValue.values ?? []).map(field) : undefined)

async function listAll() {
  const out = []
  let pageToken = ''
  do {
    const r = await lib.api('GET', `${base}/${encodeURIComponent(collection)}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}&mask.fieldPaths=key&mask.fieldPaths=stale&mask.fieldPaths=computedAt&mask.fieldPaths=deps`)
    if (!r.ok) throw new Error(`list failed: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`)
    for (const d of r.json.documents ?? []) out.push({ name: d.name, key: field(d.fields?.key), stale: field(d.fields?.stale) === true, computedAt: field(d.fields?.computedAt), deps: field(d.fields?.deps) ?? [] })
    pageToken = r.json.nextPageToken ?? ''
  } while (pageToken)
  return out
}

const age = (iso) => (iso ? `${Math.round((Date.now() - Date.parse(iso)) / 60000)}m` : '?')

if (cmd === 'list') {
  const rows = (await listAll()).filter((r) => !arg || r.key?.startsWith(arg))
  for (const r of rows.slice(0, 200)) console.log(`${r.stale ? 'STALE' : 'fresh'}  ${age(r.computedAt).padStart(6)}  ${r.key}`)
  console.log(`${rows.length} value(s) in ${collection}${rows.length > 200 ? ' (first 200 shown)' : ''}; ${rows.filter((r) => r.stale).length} stale`)
} else if (cmd === 'show' && arg) {
  const r = await lib.api('GET', `${base}/${encodeURIComponent(collection)}/${encodeURIComponent(encodeURIComponent(arg))}`)
  if (!r.ok) {
    console.log(`not stored (${r.status})`)
  } else {
    const f = r.json.fields ?? {}
    console.log({ key: field(f.key), stale: field(f.stale) === true, computedAt: field(f.computedAt), age: age(field(f.computedAt)), deps: field(f.deps), bytes: (field(f.value) ?? '').length })
  }
} else if (cmd === 'dependents' && arg) {
  const rows = (await listAll()).filter((r) => r.deps.includes(arg))
  for (const r of rows) console.log(r.key)
  console.log(`${rows.length} value(s) depend on ${arg}`)
} else if (cmd === 'purge' && (arg || has('all'))) {
  const rows = has('all') ? await listAll() : [{ name: `projects/${projectId}/databases/(default)/documents/${collection}/${encodeURIComponent(arg)}`, key: arg }]
  if (!has('yes')) {
    console.log(`would delete ${rows.length} value(s) from ${collection} on ${projectId}; re-run with --yes`)
  } else {
    for (const r of rows) await lib.api('DELETE', `https://firestore.googleapis.com/v1/${r.name}`)
    console.log(`deleted ${rows.length} value(s) from ${collection} on ${projectId}`)
  }
} else {
  console.error('usage: render-store.js --alias <a> list [prefix] | show <key> | dependents <dep> | purge <key>|--all [--version rN] [--yes]')
  process.exit(2)
}
