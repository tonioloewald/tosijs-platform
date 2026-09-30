#!/usr/bin/env bun
/**
 * Install (or upgrade) a checked-in manifest through a host's /install.
 *
 *   bun scripts/install-manifest.js manifests/blog.json --alias sandbox
 *   CONFIGURATOR_TOKEN=… bun scripts/install-manifest.js manifests/blog.json --production
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
  if (!projectId || !token) {
    console.error('--production needs a configured default project and CONFIGURATOR_TOKEN (a configurator\'s ID token)')
    process.exit(2)
  }
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
