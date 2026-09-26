#!/usr/bin/env bun
/**
 * Measure what routing a collection through the REGISTRY costs a live read (D19 step 2).
 *
 * NOTE: "bare name" is served from compiled TypeScript unless the host runs with
 * PLATFORM_CONFIGS_FROM_REGISTRY=true, in which case BOTH rows go through the
 * registry. The bare-name collections (`post`, `page`, …) are served from compiled
 * TypeScript by default; namespaced ones go through `installedRegistry` — a
 * per-instance cache with a 5 s epoch check and a 60 s reload. The deferred
 * swap would route `post` the second way. This measures the difference on a
 * real deployment rather than guessing it:
 *
 *   - installs a throwaway library whose `benchreg:post` mirrors `post`
 *     (same fields, public read/list);
 *   - copies one real published post into it;
 *   - times IDENTICAL anonymous reads of both, INTERLEAVED, so instance
 *     warmth, time of day and network drift land on both equally;
 *   - revokes the library and deletes what it wrote.
 *
 *   bun scripts/bench-registry.js --alias sandbox [--n 80]
 *
 * PACED: the platform rate-limits 100 requests/minute per IP per function
 * instance, and each round sends two to /doc and two to /docs. Rounds are
 * spaced to ~40/minute so the limiter never answers instead of the endpoint.
 *
 * Sandbox only: refuses production and unmarked hosts like every verify script.
 */
import { execSync } from 'child_process'
const lib = await import(new URL('sandbox-lib.js', import.meta.url).href)

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : dflt
}
const alias = arg('alias', 'sandbox')
const N = Number(arg('n', 80))
const ROUND_MS = 1500
const { projectId } = lib.resolveSandbox(alias)
await lib.assertProbeAllowed(projectId)

const BASE = `https://us-central1-${projectId}.cloudfunctions.net`
const fsq = (m, p, b) =>
  fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${p}`,
    {
      method: m,
      headers: { Authorization: `Bearer ${lib.token()}`, 'Content-Type': 'application/json' },
      body: b && JSON.stringify(b),
    }
  )

const out = execSync(
  `bun ${new URL('sandbox-token.js', import.meta.url).pathname} --alias ${alias} ` +
    '--role benchreg --grant configurator,author --export',
  { encoding: 'utf-8', cwd: new URL('..', import.meta.url).pathname }
)
const tok = out.match(/SANDBOX_ID_TOKEN=(\S+)/)[1]
const roleDoc = (out.match(/SANDBOX_ROLE_DOC=(\S+)/) ?? [])[1]
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }

// A real published post, as the source of a realistic document.
const listed = await fetch(`${BASE}/docs?p=post&c=20`).then((r) => r.json())
const source = (Array.isArray(listed) ? listed : listed.rows ?? []).find(
  (p) => p.date && p.content
)
if (!source) throw new Error('no published post on this host to copy')
const postId = source._path.split('/')[1]
const full = await fetch(`${BASE}/doc?p=${encodeURIComponent(source._path)}`).then((r) => r.json())
const content = {}
for (const k of ['title', 'content', 'path', 'date', 'summary', 'keywords', 'imageUrl', 'author', 'format']) {
  if (full[k] !== undefined) content[k] = full[k]
}

const M = {
  manifest: 1,
  name: 'benchreg',
  version: '1.0.0',
  collections: {
    'benchreg:post': {
      schema: {
        type: 'object',
        properties: Object.fromEntries(
          ['title', 'content', 'path', 'date', 'summary', 'author', 'format', 'imageUrl']
            .map((k) => [k, { type: 'string' }])
            .concat([['keywords', { type: 'array', items: { type: 'string' } }]])
        ),
        required: ['title', 'content'],
      },
      access: [
        { role: 'public', read: 'ALL', list: 'ALL' },
        { role: 'author', write: 'ALL' },
      ],
    },
  },
}

const cleanup = async () => {
  await fetch(`${BASE}/install?name=benchreg`, { method: 'DELETE', headers: H }).catch(() => {})
  await fsq('DELETE', `benchreg%3Apost/${postId}`)
  if (roleDoc) await fsq('DELETE', roleDoc)
}

try {
  const inst = await fetch(`${BASE}/install`, { method: 'POST', headers: H, body: JSON.stringify({ manifest: M }) })
  if (inst.status !== 200) throw new Error(`install failed: ${inst.status} ${await inst.text()}`)
  // Let every instance's registry see the new epoch (5 s check).
  await new Promise((r) => setTimeout(r, 8000))
  const w = await fetch(`${BASE}/doc`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ p: `benchreg:post/${postId}`, data: content }),
  })
  if (w.status !== 200) throw new Error(`copy failed: ${w.status} ${await w.text()}`)

  const time = async (url) => {
    const t = performance.now()
    const r = await fetch(url)
    await r.arrayBuffer()
    if (r.status !== 200) throw new Error(`${url} → ${r.status}`)
    return performance.now() - t
  }
  const targets = {
    'doc  bare name (post)': `${BASE}/doc?p=post/${postId}`,
    'doc  installed (benchreg:post)': `${BASE}/doc?p=benchreg:post/${postId}`,
    'docs bare name (post)': `${BASE}/docs?p=post&c=10`,
    'docs installed (benchreg:post)': `${BASE}/docs?p=benchreg:post&c=10`,
  }
  // Warm-up: first requests pay cold starts, which are not what we compare.
  for (let i = 0; i < 3; i++) {
    for (const url of Object.values(targets)) await time(url)
    await new Promise((r) => setTimeout(r, ROUND_MS))
  }

  const samples = Object.fromEntries(Object.keys(targets).map((k) => [k, []]))
  for (let i = 0; i < N; i++) {
    const started = Date.now()
    for (const [k, url] of Object.entries(targets)) samples[k].push(await time(url))
    const rest = ROUND_MS - (Date.now() - started)
    if (rest > 0) await new Promise((r) => setTimeout(r, rest))
  }

  const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]
  const row = (k) => {
    const a = samples[k]
    const mean = a.reduce((s, x) => s + x, 0) / a.length
    return `${k.padEnd(32)} p50 ${q(a, 0.5).toFixed(0).padStart(4)}  p90 ${q(a, 0.9).toFixed(0).padStart(4)}  p99 ${q(a, 0.99).toFixed(0).padStart(4)}  mean ${mean.toFixed(0).padStart(4)} ms`
  }
  console.log(`\nbench-registry → ${projectId}, n=${N} per target, interleaved, anonymous\n`)
  for (const k of Object.keys(targets)) console.log(row(k))
  const d = (a, b) => q(samples[b], 0.5) - q(samples[a], 0.5)
  console.log(
    `\ninstalled − bare name, p50:  /doc ${d('doc  bare name (post)', 'doc  installed (benchreg:post)').toFixed(0)} ms,` +
      `  /docs ${d('docs bare name (post)', 'docs installed (benchreg:post)').toFixed(0)} ms\n`
  )
} finally {
  await cleanup()
}
