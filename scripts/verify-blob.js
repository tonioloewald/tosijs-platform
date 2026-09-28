#!/usr/bin/env bun
/**
 * Acceptance for storage areas (#1136 step 2), against a real deployed host
 * and real Cloud Storage.
 *
 * A storage area is a collection: this installs a throwaway library whose two
 * areas are declared exactly like collections (a public one and a private
 * one), then exercises /blob end to end — upload, anonymous public read
 * followed through the redirect to the actual bytes, private read denied to a
 * stranger and served to its reader, the limits, the refusal of direct /doc
 * writes, replace, move and delete — and cleans up.
 *
 * Targets an alias, sandbox-guarded like every script here:
 *   bun scripts/verify-blob.js --alias sandbox
 */
import { execSync } from 'child_process'
import { createHash } from 'crypto'
const lib = await import(new URL('sandbox-lib.js', import.meta.url).href)
const alias = (() => {
  const i = process.argv.indexOf('--alias')
  return i > -1 ? process.argv[i + 1] : 'sandbox'
})()
const { projectId } = lib.resolveSandbox(alias)
await lib.assertProbeAllowed(projectId)
const BASE = `https://us-central1-${projectId}.cloudfunctions.net`

const out = execSync(
  `bun ${new URL('sandbox-token.js', import.meta.url).pathname} --alias ${alias} --role blobtest --grant configurator,author --export`,
  { encoding: 'utf-8', cwd: new URL('..', import.meta.url).pathname }
)
const tok = out.match(/SANDBOX_ID_TOKEN=(\S+)/)[1]
const roleDoc = (out.match(/SANDBOX_ROLE_DOC=(\S+)/) ?? [])[1]
const AUTH = { Authorization: `Bearer ${tok}` }

let fails = 0
let n = 0
const ok = (label, cond, detail = '') => {
  n++
  console.log(`${cond ? '  ok' : 'FAIL'}  ${n}. ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) fails++
}
const sha = (s) => createHash('sha256').update(s).digest('hex')
const blobUrl = (area, path) => `${BASE}/blob/${area}/${path}`
const put = (area, path, body, type = 'text/plain', headers = AUTH) =>
  fetch(blobUrl(area, path), { method: 'PUT', headers: { ...headers, 'Content-Type': type }, body })
const get = (area, path, headers = {}) => fetch(blobUrl(area, path), { headers, redirect: 'manual' })
const follow = async (res) => {
  const loc = res.headers.get('location')
  return loc ? (await fetch(loc)).text() : res.text()
}

const M = {
  manifest: 1,
  name: 'blobtest',
  version: '1.0.0',
  collections: {
    'blobtest:public': {
      blob: { maxBytes: 1000, contentTypes: ['text/plain', 'image/*'] },
      access: [
        { role: 'public', read: 'ALL', list: 'ALL' },
        { role: 'author', write: 'ALL' },
      ],
    },
    'blobtest:private': {
      blob: { maxBytes: 1000 },
      access: [{ role: 'author', read: 'ALL', list: 'ALL', write: 'ALL' }],
    },
  },
}

const cleanup = async () => {
  for (const [area, path] of [
    ['blobtest:public', 'hello.txt'],
    ['blobtest:public', 'moved.txt'],
    ['blobtest:private', 'secret.txt'],
  ]) {
    await fetch(blobUrl(area, path), { method: 'DELETE', headers: AUTH }).catch(() => {})
  }
  await fetch(`${BASE}/install?name=blobtest`, { method: 'DELETE', headers: AUTH }).catch(() => {})
}

try {
  await cleanup()
  const inst = await fetch(`${BASE}/install`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest: M }),
  })
  ok('a manifest may declare storage areas (collections with blob limits)', inst.status === 200, `${inst.status} ${(await inst.text()).slice(0, 80)}`)
  await new Promise((r) => setTimeout(r, 8000)) // let every instance see the new epoch

  const body = 'hello, blob'
  const p1 = await put('blobtest:public', 'hello.txt', body)
  const p1j = await p1.json().catch(() => ({}))
  ok('an author uploads a file', p1.status === 200 && p1j.status === 'stored', `${p1.status} ${JSON.stringify(p1j)}`)
  ok('size and hash are measured by the server', p1j.bytes === body.length && p1j.sha256 === sha(body), JSON.stringify(p1j))

  const g1 = await get('blobtest:public', 'hello.txt')
  // Delivery is a redirect to a signed URL when the host can sign, else the
  // bytes streamed through the function. Both are correct; what must hold is
  // the access decision and the cache policy.
  const mode = (r) => (r.status === 302 ? 'redirect' : r.status === 200 ? 'stream' : `status ${r.status}`)
  ok('a public file is served to anyone, CACHEABLE', (g1.status === 302 || g1.status === 200) && /public/.test(g1.headers.get('cache-control') ?? ''), `${mode(g1)}, ${g1.headers.get('cache-control')}`)
  ok('…which leads to the actual bytes', (await follow(g1)) === body)

  const list = await fetch(`${BASE}/docs?p=blobtest:public&c=10`).then((r) => r.json()).catch(() => null)
  const rows = Array.isArray(list) ? list : list?.rows ?? []
  const row = rows.find((r) => r.path === 'hello.txt')
  ok('its metadata lists through /docs under the area\'s rules, with provenance', Boolean(row?._by?.uid) && row?.sha256 === sha(body), JSON.stringify(row ?? rows).slice(0, 120))

  const big = await put('blobtest:public', 'big.txt', 'x'.repeat(1001))
  ok('over the area\'s limit → 413 too-large', big.status === 413 && (await big.json()).error === 'too-large', String(big.status))
  const pdf = await put('blobtest:public', 'doc.pdf', 'x', 'application/pdf')
  ok('a type outside the area\'s list → 415 unsupported-type', pdf.status === 415 && (await pdf.json()).error === 'unsupported-type', String(pdf.status))
  const anon = await put('blobtest:public', 'anon.txt', 'x', 'text/plain', {})
  ok('an anonymous upload → the opaque 404', anon.status === 404, String(anon.status))

  const direct = await fetch(`${BASE}/doc`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p: 'blobtest:public/fake', data: { path: 'fake', contentType: 'text/plain', bytes: 1, sha256: 'a'.repeat(64) } }),
  })
  ok('a direct /doc write to an area is refused — no metadata without a file', direct.status === 403 && (await direct.json()).error === 'refused', String(direct.status))

  const secret = 'eyes only'
  await put('blobtest:private', 'secret.txt', secret)
  const stranger = await get('blobtest:private', 'secret.txt')
  ok('a private file is invisible to a stranger (opaque 404)', stranger.status === 404, String(stranger.status))
  const reader = await get('blobtest:private', 'secret.txt', AUTH)
  ok('its reader is served it, never cached', (reader.status === 302 || reader.status === 200) && (reader.headers.get('cache-control') ?? '').includes('no-store'), `${mode(reader)}, ${reader.headers.get('cache-control')}`)
  ok('…which leads to the bytes', (await follow(reader)) === secret)

  const replaced = await put('blobtest:public', 'hello.txt', 'hello again')
  ok('a changed upload replaces the file', (await replaced.json()).status === 'replaced')
  ok('…and readers get the new bytes', (await follow(await get('blobtest:public', 'hello.txt'))) === 'hello again')

  const mv = await fetch(`${BASE}/blob`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'move', from: { area: 'blobtest:public', path: 'hello.txt' }, to: { area: 'blobtest:public', path: 'moved.txt' } }),
  })
  ok('a move is done on the server', mv.status === 200 && (await mv.json()).status === 'moved', String(mv.status))
  ok('…the source is gone', (await get('blobtest:public', 'hello.txt')).status === 404)
  ok('…and the destination serves the bytes', (await follow(await get('blobtest:public', 'moved.txt'))) === 'hello again')

  const del = await fetch(blobUrl('blobtest:public', 'moved.txt'), { method: 'DELETE', headers: AUTH })
  ok('delete removes the file', del.status === 200 && (await get('blobtest:public', 'moved.txt')).status === 404, String(del.status))
} finally {
  await cleanup()
  if (roleDoc) {
    await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${roleDoc}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${lib.token()}` },
    }).catch(() => {})
  }
}

console.log(fails ? `\n${fails} of ${n} FAILED\n` : `\nall ${n} checks passed\n`)
process.exit(fails ? 1 : 0)
