#!/usr/bin/env bun

/**
 * Reference CLI login — the client half of the browser loop (B2, #6).
 *
 * Deliberately a readable script rather than a package. A consumer should be
 * able to read the whole protocol in one sitting and reimplement it in whatever
 * language their agent is written in; waiting on a published CLI would block
 * adoption on a release nobody has asked for yet.
 *
 *   bun scripts/cli-login.js --host https://us-central1-PROJECT.cloudfunctions.net \
 *     --label "macbook × myrepo" --roles author --collections virta:task
 *
 * Add `--poll` for a machine with no browser and no reachable loopback port —
 * a cloud sandbox, a container, an SSH session. Read the warning it prints.
 *
 * ## The three things that matter
 *
 * 1. the VERIFIER never leaves this process. Only its sha256 is sent. So a
 *    consent URL, a browser history entry, or a stolen request id is useless
 *    on its own.
 * 2. the token arrives ONLY here, at the exchange, over TLS. It never passes
 *    through the browser.
 * 3. loopback binds 127.0.0.1 and checks that the request id coming back is
 *    the one it started. That binding is what makes a phished approval
 *    useless: the redirect never leaves the approver's machine.
 */

import { createHash, randomBytes } from 'crypto'
import { createServer } from 'http'
import { writeFileSync, mkdirSync, chmodSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)
const listArg = (name) => {
  const v = arg(name, '')
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined
}

const HOST = (arg('host', process.env.TOSIJS_HOST) ?? '').replace(/\/$/, '')
if (!HOST) {
  console.error('usage: cli-login.js --host https://…cloudfunctions.net [--label …] [--roles a,b] [--poll]')
  process.exit(1)
}
const LABEL = arg('label', `${process.env.USER ?? 'agent'} × ${path.basename(process.cwd())}`)
const ROLES = listArg('roles') ?? ['author']
const COLLECTIONS = listArg('collections')
const METHODS = listArg('methods')
const POLL = flag('poll')

const post = async (action, body) => {
  const res = await fetch(`${HOST}/authorize?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, json: null, text }
  }
}

// 1. The verifier stays here. Only its hash is sent.
const verifier = randomBytes(32).toString('base64url')
const codeChallenge = createHash('sha256').update(verifier).digest('base64url')

// 2. A loopback listener, bound to 127.0.0.1 only — never 0.0.0.0, which would
//    accept the redirect from anywhere on the network.
let redirectPort
let awaitRedirect = Promise.resolve(null)
let server
if (!POLL) {
  server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  redirectPort = server.address().port
  awaitRedirect = new Promise((resolve) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${redirectPort}`)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset=utf-8><title>Done</title>' +
        '<body style="font:16px system-ui;padding:2rem">You can close this tab ' +
        'and return to your terminal.</body>')
      resolve(url.searchParams.get('request'))
    })
  })
}

const started = await post('start', {
  label: LABEL,
  caveats: {
    roles: ROLES,
    ...(COLLECTIONS ? { collections: COLLECTIONS } : {}),
    ...(METHODS ? { methods: METHODS } : {}),
  },
  codeChallenge,
  mode: POLL ? 'poll' : 'loopback',
  ...(redirectPort ? { redirectPort } : {}),
})

if (started.status !== 200) {
  console.error('could not start:', JSON.stringify(started.json ?? started.text))
  server?.close()
  process.exit(1)
}
const { requestId, consentUrl } = started.json

console.log(`\n  ${LABEL}`)
console.log(`  roles: ${ROLES.join(', ')}${COLLECTIONS ? `  collections: ${COLLECTIONS.join(', ')}` : ''}`)
if (POLL) {
  console.log(
    '\n  ⚠  Polling mode. The result is collected by whoever is waiting for it.\n' +
      '     Only approve a URL you generated yourself, on a machine you control.'
  )
}
console.log(`\n  Open this to approve:\n\n    ${consentUrl}\n`)

if (!POLL) {
  // Best effort — an SSH session has no opener and should just show the URL.
  const open =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    const { spawn } = await import('child_process')
    spawn(open, [consentUrl], { stdio: 'ignore', detached: true }).unref()
  } catch {
    /* the URL is printed above; that is enough */
  }
}

// 3. Wait — by redirect if we can, by polling if we cannot. Either way the
//    exchange below is identical and always needs the verifier.
if (!POLL) {
  const returned = await Promise.race([
    awaitRedirect,
    new Promise((resolve) => setTimeout(() => resolve(null), 10 * 60_000)),
  ])
  server.close()
  if (returned !== requestId) {
    // Something else hit the loopback port, or nothing did before the request
    // expired. Either way this is not the approval we asked for.
    console.error('\n  no matching approval came back — aborting\n')
    process.exit(1)
  }
}

const deadline = Date.now() + 10 * 60_000
let result
for (;;) {
  result = await post('exchange', { requestId, verifier })
  if (result.json?.status !== 'pending') break
  if (Date.now() > deadline) {
    console.error('\n  timed out waiting for approval\n')
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, result.json.pollIntervalMs ?? 2000))
}

if (result.json?.status !== 'ready') {
  console.error('\n  refused:', JSON.stringify(result.json ?? result.text), '\n')
  process.exit(1)
}

// Stored 0600 in a directory only this user can read. The token is a bearer
// credential; the filesystem is the only thing protecting it at rest.
const dir = path.join(homedir(), 'local-secrets')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const file = path.join(dir, `tosijs-${new URL(HOST).hostname}.json`)
writeFileSync(
  file,
  JSON.stringify(
    {
      host: HOST,
      token: result.json.secret,
      label: result.json.label,
      caveats: result.json.caveats,
      expiresAt: result.json.expiresAt,
    },
    null,
    2
  ) + '\n',
  { mode: 0o600 }
)
chmodSync(file, 0o600)

console.log(`  ✓ token stored in ${file}`)
console.log(`    expires ${result.json.expiresAt}\n`)
