#!/usr/bin/env bun
/**
 * Acceptance for the browser-loop authorization (B2, #6), against a deployed host.
 *
 * Drives the protocol directly — the consent page is a thin client over exactly
 * these calls, so this covers the same ground without a browser.
 *
 * Sandbox only, via the same resolveSandbox() guard as every script here.
 */
import { execSync } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import path from 'path'
import { resolveSandbox, projectRoot, parseArgs, token } from './sandbox-lib.js'

const { val } = parseArgs(process.argv)
const ALIAS = val('alias') ?? 'sandbox'
const { projectId } = resolveSandbox(ALIAS)
const BASE = `https://us-central1-${projectId}.cloudfunctions.net`

let failures = 0, step = 0
const ok = (label, cond, detail = '') => {
  step += 1
  console.log(`${cond ? '  ok' : 'FAIL'}  ${String(step).padStart(2)}. ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures += 1
}
const fatal = (m) => { console.error(`\nABORTED: ${m}`); process.exit(1) }

const post = async (action, body, bearer) => {
  const res = await fetch(`${BASE}/authorize?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = null }
  return { status: res.status, text, json }
}

/**
 * Direct datastore access, for cleanup.
 *
 * Needed because the probe below is a POST, which correctly refuses to
 * overwrite — so a leftover from the previous run reads as a permissions
 * failure. That already produced one false FAIL here.
 */
const firestore = (method, docPath) =>
  fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
      `/databases/(default)/documents/${docPath}`,
    { method, headers: { Authorization: `Bearer ${token()}` } }
  )

console.log(`\nverify-authorize → ${projectId}\n`)

await firestore('DELETE', 'post/authz-probe')

const out = execSync(
  `bun ${path.join(projectRoot, 'scripts', 'sandbox-token.js')} --alias ${ALIAS} --role authz --grant author,admin --export`,
  { encoding: 'utf-8', cwd: projectRoot }
)
const human = (out.match(/SANDBOX_ID_TOKEN=(\S+)/) ?? [])[1]
if (!human) fatal('no human id token')

// --- the config the consent page needs --------------------------------------
const cfg = await fetch(`${BASE}/authorize?action=config`).then(r => r.json()).catch(() => null)
ok('a fresh host can serve its own web config — nothing to configure',
   Boolean(cfg?.apiKey && cfg?.authDomain), JSON.stringify(Object.keys(cfg ?? {})))

// --- start -------------------------------------------------------------------
const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const started = await post('start', {
  label: 'ci × verify-authorize',
  caveats: { roles: ['author'], collections: ['post'] },
  codeChallenge: challenge,
  mode: 'poll',
})
ok('a CLI with no credentials can start a request', started.status === 200 && started.json?.requestId,
   `${started.status} ${started.text.slice(0, 120)}`)
const requestId = started.json?.requestId
if (!requestId) fatal('no requestId')

// --- the consent page renders -------------------------------------------------
const page = await fetch(`${BASE}/authorize?request=${requestId}`).then(async r => ({ s: r.status, t: await r.text(), csp: r.headers.get('content-security-policy'), cc: r.headers.get('cache-control') }))
ok('the consent page renders the request', page.s === 200 && page.t.includes('ci × verify-authorize'), String(page.s))
ok('it shows the exact caveats a human is approving',
   page.t.includes('<code>author</code>') && page.t.includes('<code>post</code>'), '')
ok('poll mode shows the phishing warning', page.t.includes('Check you started this'), '')
ok('it is served no-store, under a CSP', page.cc === 'no-store' && /default-src 'none'/.test(page.csp ?? ''), `${page.cc}`)

// --- nothing is obtainable before approval ------------------------------------
const early = await post('exchange', { requestId, verifier })
ok('before approval the exchange says pending, and nothing else',
   early.status === 200 && early.json?.status === 'pending' && !early.text.includes('tsp_'),
   `${early.status} ${early.text.slice(0, 80)}`)

const noVerifier = await post('exchange', { requestId, verifier: 'wrong-verifier-entirely' })
ok('a wrong verifier cannot even learn the request state',
   noVerifier.status === 403 && !/pending/.test(noVerifier.text),
   `${noVerifier.status} ${noVerifier.text.slice(0, 80)}`)

const anonApprove = await post('approve', { requestId, approve: true })
ok('an unauthenticated caller cannot approve', anonApprove.status === 401, String(anonApprove.status))

// --- approve (what the page does) ----------------------------------------------
const approved = await post('approve', { requestId, approve: true }, human)
ok('a signed-in human approves', approved.status === 200 && approved.json?.status === 'approved',
   `${approved.status} ${approved.text.slice(0, 120)}`)
ok('the approval response carries no credential', !/tsp_/.test(approved.text), approved.text.slice(0, 80))

const reApprove = await post('approve', { requestId, approve: true }, human)
ok('a request cannot be approved twice', reApprove.status === 400, `${reApprove.status} ${reApprove.text.slice(0, 80)}`)

// --- exchange --------------------------------------------------------------------
const got = await post('exchange', { requestId, verifier })
ok('the CLI exchanges verifier for a token', got.status === 200 && got.json?.status === 'ready' && got.json?.secret?.startsWith('tsp_'),
   `${got.status} ${got.text.slice(0, 100)}`)
ok('minted with exactly the approved caveats',
   JSON.stringify(got.json?.caveats?.roles) === '["author"]' && JSON.stringify(got.json?.caveats?.collections) === '["post"]',
   JSON.stringify(got.json?.caveats))

const replay = await post('exchange', { requestId, verifier })
ok('the request is good for exactly ONE token', replay.status === 403, `${replay.status} ${replay.text.slice(0, 80)}`)

// --- the token actually works, within its caveats ---------------------------------
const agent = got.json?.secret
const wrote = await fetch(`${BASE}/doc`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agent}` },
  body: JSON.stringify({ p: 'post/authz-probe', data: { title: 'via browser loop', content: 'x' } }),
})
ok('the resulting token works where it was scoped', wrote.status === 200, String(wrote.status))
const offScope = await fetch(`${BASE}/doc?p=config/site`, { headers: { Authorization: `Bearer ${agent}` } })
ok('and nowhere else', offScope.status === 404, String(offScope.status))

// --- a token cannot bootstrap another --------------------------------------------
const second = await post('start', {
  label: 'sibling attempt', caveats: { roles: ['author'] },
  codeChallenge: challenge, mode: 'poll',
})
const tokenApprove = await post('approve', { requestId: second.json?.requestId, approve: true }, agent)
ok('an agent token cannot approve an authorization', tokenApprove.status === 401,
   `${tokenApprove.status} ${tokenApprove.text.slice(0, 80)}`)

// --- refusals at start -------------------------------------------------------------
const badPort = await post('start', { label: 'privileged port', caveats: { roles: ['author'] }, codeChallenge: challenge, mode: 'loopback', redirectPort: 443 })
ok('a privileged loopback port is refused', badPort.status === 400 && /unprivileged/.test(badPort.text), String(badPort.status))

const noRoles = await post('start', { label: 'no roles', caveats: {}, codeChallenge: challenge, mode: 'poll' })
ok('a request with no roles is refused — the human must see what they grant',
   noRoles.status === 400, `${noRoles.status} ${noRoles.text.slice(0, 80)}`)

await firestore('DELETE', 'post/authz-probe')

console.log(failures ? `\n${failures} of ${step} checks FAILED\n` : `\nall ${step} checks passed\n`)
process.exit(failures ? 1 : 0)
