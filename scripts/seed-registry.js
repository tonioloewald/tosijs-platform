#!/usr/bin/env bun
/**
 * Write the platform's collection configs into `system:registry` (D19).
 *
 * With `PLATFORM_CONFIGS_FROM_REGISTRY=true`, `/doc` and `/docs` read `post`,
 * `page`, `role`, … from `system:registry/<name>` instead of compiled
 * TypeScript. This puts them there: `PLATFORM_CONFIGS` from
 * `functions/src/collections/seed-configs.ts`, which `seed-parity` tests keep
 * identical in behaviour to what ships.
 *
 * It is the ONLY sanctioned way those documents change. `system` is reserved,
 * so nothing reaches them through `/doc` — this runs with the operator's own
 * datastore access (gcloud), which is the "outside privileges" the design
 * relies on for fixing a broken rule.
 *
 * ## Safety
 *
 *   - DRY RUN by default: prints what differs. `--apply` writes.
 *   - One atomic commit: every changed config AND an epoch bump, so every
 *     instance reloads onto the new set together, never onto half of it.
 *   - Never deletes. A stored config with no counterpart here is REPORTED —
 *     removing a collection's rules makes it inaccessible, and that should be a
 *     deliberate act, not a side effect of a seed.
 *   - Production (the `default` alias) requires `--production` as well.
 *
 *   bun scripts/seed-registry.js --alias sandbox            # what would change
 *   bun scripts/seed-registry.js --alias sandbox --apply
 *   bun scripts/seed-registry.js --alias default --production --apply
 *   bun scripts/seed-registry.js --alias default --production --check
 *
 * `--check` exits 1 unless every config is `unchanged` (and nothing is stored
 * that the code does not know). Run it before deploying with the switch on:
 * flipping the switch onto an unseeded or stale registry makes collections
 * inaccessible.
 */
import { readRc, token, parseArgs, productionProjectId } from './sandbox-lib.js'

const { has, val } = parseArgs(process.argv)
// --emulator: seed the LOCAL Firestore emulator (what `bun seed` calls), so the
// emulator's registry matches production's. The emulator loads the production
// switch file too (.env.<projectId>), and an unseeded registry makes every
// platform collection inaccessible — which is how the integration suites went
// red on 2026-09-26. `Bearer owner` is the emulator's admin credential.
const EMULATOR = has('emulator')
const alias = val('alias') ?? (EMULATOR ? 'default' : undefined)
const projectId = alias ? readRc().projects?.[alias] : null
if (!projectId) {
  console.error('usage: bun scripts/seed-registry.js --alias <alias> [--apply] [--production] | --emulator [--apply]')
  process.exit(2)
}
const isProduction =
  !EMULATOR && (alias === 'default' || projectId === productionProjectId())
if (isProduction && !has('production')) {
  console.error(`Refusing: "${alias}" is PRODUCTION (${projectId}). Add --production to confirm.`)
  process.exit(2)
}

const { PLATFORM_CONFIGS } = await import('../functions/src/collections/seed-configs.ts')
const { platformDocId, PLATFORM_REGISTRY_COLLECTION } = await import(
  '../functions/src/install/platform-configs.ts'
)

// --- Firestore REST value encoding -----------------------------------------
const toValue = (v) => {
  if (v === null || v === undefined) return { nullValue: null }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  if (typeof v === 'string') return { stringValue: v }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } }
  return { mapValue: { fields: toFields(v) } }
}
const toFields = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toValue(x)]))
const fromValue = (v) => {
  if ('nullValue' in v) return null
  if ('booleanValue' in v) return v.booleanValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('stringValue' in v) return v.stringValue
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fromValue)
  if ('mapValue' in v) return fromFields(v.mapValue.fields ?? {})
  return undefined
}
const fromFields = (f) => Object.fromEntries(Object.entries(f).map(([k, x]) => [k, fromValue(x)]))
const stable = (v) =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(stable).join(',')}]`
      : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`

// --- read what is stored ----------------------------------------------------
const root = `projects/${projectId}/databases/(default)/documents`
const API = EMULATOR ? 'http://127.0.0.1:8080/v1' : 'https://firestore.googleapis.com/v1'
const headers = {
  Authorization: `Bearer ${EMULATOR ? 'owner' : token()}`,
  'Content-Type': 'application/json',
}
const stored = new Map()
let pageToken
do {
  const url = new URL(
    `${API}/${root}/${encodeURIComponent(PLATFORM_REGISTRY_COLLECTION)}`
  )
  url.searchParams.set('pageSize', '300')
  if (pageToken) url.searchParams.set('pageToken', pageToken)
  const res = await fetch(url, { headers })
  if (!res.ok && res.status !== 404) throw new Error(`list: ${res.status} ${await res.text()}`)
  const body = res.ok ? await res.json() : {}
  for (const d of body.documents ?? []) stored.set(d.name.split('/').pop(), fromFields(d.fields ?? {}))
  pageToken = body.nextPageToken
} while (pageToken)

// --- diff -------------------------------------------------------------------
// The stored document is exactly `{ name, collection }` — see
// `platformConfigsFrom`, which is the load half of this contract.
const wanted = new Map(
  PLATFORM_CONFIGS.map((c) => [
    platformDocId(c.name),
    JSON.parse(JSON.stringify({ name: c.name, collection: c.collection })),
  ])
)
const changes = []
for (const [id, doc] of wanted) {
  const current = stored.get(id)
  if (!current) changes.push({ id, doc, kind: 'add' })
  else if (stable({ name: current.name, collection: current.collection }) !== stable(doc))
    changes.push({ id, doc, kind: 'change' })
}
const extra = [...stored.keys()].filter((id) => id !== 'epoch' && !wanted.has(id))

console.log(`\nseed-registry → ${projectId}${EMULATOR ? '  (EMULATOR)' : isProduction ? '  (PRODUCTION)' : ''}\n`)
for (const id of wanted.keys()) {
  const c = changes.find((x) => x.id === id)
  console.log(`   ${c ? c.kind.padEnd(9) : 'unchanged'} ${id}`)
}
for (const id of extra) console.log(`   EXTRA     ${id}  (stored, not in PLATFORM_CONFIGS — left alone)`)

if (has('check')) {
  const ok = !changes.length && !extra.length
  console.log(ok ? '\nCHECK OK — the stored registry matches the code' : '\nCHECK FAILED — seed (or reconcile EXTRA) before enabling the switch')
  process.exit(ok ? 0 : 1)
}
if (!changes.length) {
  console.log('\nnothing to write')
  process.exit(0)
}
if (!has('apply')) {
  console.log(`\nDRY RUN — ${changes.length} config(s) would be written, plus an epoch bump. Re-run with --apply.`)
  process.exit(0)
}

// --- one atomic commit: configs + epoch -------------------------------------
const writes = changes.map(({ id, doc }) => ({
  update: { name: `${root}/${PLATFORM_REGISTRY_COLLECTION}/${id}`, fields: toFields(doc) },
}))
writes.push({
  update: {
    name: `${root}/${PLATFORM_REGISTRY_COLLECTION}/epoch`,
    fields: { at: { stringValue: new Date().toJSON() } },
  },
  updateMask: { fieldPaths: ['at'] },
  updateTransforms: [{ fieldPath: 'value', increment: { integerValue: '1' } }],
})
const res = await fetch(`${API}/${root}:commit`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ writes }),
})
if (!res.ok) {
  console.error(`\nCOMMIT FAILED (${res.status}) — nothing was written:\n${await res.text()}`)
  process.exit(1)
}
console.log(`\nwrote ${changes.length} config(s) and bumped the epoch, atomically`)
