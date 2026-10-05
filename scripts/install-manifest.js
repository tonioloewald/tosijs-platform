#!/usr/bin/env bun
/**
 * Install (or upgrade) a checked-in manifest through a host's /install.
 *
 *   bun scripts/install-manifest.js manifests/blog.json --production          # approve in the browser
 *   bun scripts/install-manifest.js manifests/blog.json --alias sandbox --browser
 *   bun scripts/install-manifest.js manifests/blog.json --alias sandbox          # throwaway configurator
 *
 * APPROVE IN THE BROWSER (board #2490; the default for --production): the
 * manifest is PROPOSED without credentials; the host answers with a link and a
 * confirmation code; a configurator opens the link, checks the code, signs in,
 * sees a dry run, and approves. `configurator` authority never leaves the
 * browser, and nothing is pasted anywhere.
 *
 * On a sandbox it mints a throwaway configurator (sandbox-token.js) and
 * removes its role document afterwards. On PRODUCTION it never mints anything:
 * it needs a real configurator's ID token in CONFIGURATOR_TOKEN — e.g. from a
 * signed-in browser, `await fb.auth.currentUser.getIdToken()` — and the
 * `--production` flag, so a production install is always a deliberate act.
 * (An environment variable, not an argument: argv shows up in `ps` and shell
 * history. `--token` still works.)
 */
import fs from 'fs'
import { execSync } from 'child_process'
import * as lib from './sandbox-lib.js'

const { has, val } = lib.parseArgs(process.argv)
const file = process.argv[2]
if (!file || file.startsWith('--')) {
  console.error('usage: bun scripts/install-manifest.js <manifest.json> (--alias <sandbox> | --production --token <idToken>)')
  process.exit(2)
}
const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'))

let projectId, token, roleDoc
if (has('production')) {
  projectId = lib.productionProjectId()
  token = process.env.CONFIGURATOR_TOKEN || val('token')
  if (!projectId) {
    console.error('--production needs a configured default project')
    process.exit(2)
  }
} else if (has('browser')) {
  projectId = lib.resolveSandbox(val('alias') ?? 'sandbox').projectId
} else {
  const alias = val('alias') ?? 'sandbox'
  projectId = lib.resolveSandbox(alias).projectId
  await lib.assertProbeAllowed(projectId)
  const out = execSync(
    `bun ${new URL('sandbox-token.js', import.meta.url).pathname} --alias ${alias} --role installer --grant configurator --export`,
    { encoding: 'utf-8', cwd: lib.projectRoot }
  )
  token = out.match(/SANDBOX_ID_TOKEN=(\S+)/)[1]
  roleDoc = (out.match(/SANDBOX_ROLE_DOC=(\S+)/) ?? [])[1]
}

// No token: propose it and let a configurator approve in the browser.
if (!token) {
  // Through the site's own address, so the approval link the host answers with
  // is one Google sign-in works on (lib.siteBase).
  const base = `${lib.siteBase(projectId)}/install`
  const res = await fetch(`${base}?action=propose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  })
  const proposed = await res.json().catch(() => ({}))
  if (!res.ok || !proposed.requestId) {
    console.error(`${projectId}: could not propose (${res.status}) ${JSON.stringify(proposed).slice(0, 200)}`)
    process.exit(1)
  }
  console.log(`${projectId}: proposed ${manifest.name}@${manifest.version}.`)
  console.log(`\n  Confirmation code:  ${proposed.code}\n`)
  console.log(`Open this, check the code matches, sign in as the host's configurator, and approve:\n  ${proposed.url}\n`)
  if (!has('no-open')) {
    try {
      execSync(`open "${proposed.url}"`)
    } catch {
      // no browser to open: the link above is enough
    }
  }
  const deadline = Date.parse(proposed.expiresAt)
  let state = 'pending'
  let result
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500))
    const s = await fetch(`${base}?action=status&request=${proposed.requestId}`).then((r) => r.json()).catch(() => ({}))
    state = s.status ?? state
    result = s.result
    if (!['pending', 'deciding'].includes(state)) break
  }
  console.log(`${projectId}: ${manifest.name}@${manifest.version} → ${state}${result ? ' ' + JSON.stringify(result) : ''}`)
  process.exit(state === 'installed' ? 0 : 1)
}

try {
  const res = await fetch(`https://us-central1-${projectId}.cloudfunctions.net/install`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  })
  const text = await res.text()
  console.log(`${projectId}: ${manifest.name}@${manifest.version} → ${res.status} ${text}`)
  process.exitCode = res.ok ? 0 : 1
} finally {
  if (roleDoc) {
    await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${roleDoc}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${lib.token()}` },
    }).catch(() => {})
  }
}
