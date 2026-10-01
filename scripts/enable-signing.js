#!/usr/bin/env bun
/**
 * Let an EXISTING host's functions sign URLs (new hosts get this from the
 * provisioner, step 5c). One narrow binding, no console:
 *
 *   bun scripts/enable-signing.js --alias default --dry-run
 *   bun scripts/enable-signing.js --alias default
 *
 * Grants the functions' runtime service account "Service Account Token
 * Creator" on ITSELF (see grantSelfSigning in sandbox-lib.js).
 */
import * as lib from './sandbox-lib.js'

const { has, val } = lib.parseArgs(process.argv)
const alias = val('alias') ?? 'default'
const projectId = lib.readRc().projects?.[alias]
if (!projectId) {
  console.error(`No project for alias "${alias}" in .firebaserc`)
  process.exit(2)
}
const { account, changed } = await lib.grantSelfSigning(projectId, { dryRun: has('dry-run') })
console.log(
  `${projectId}: ${account} ` +
    (changed ? (has('dry-run') ? 'would be granted Token Creator on itself' : 'granted Token Creator on itself') : 'can already sign as itself')
)
