#!/usr/bin/env bun
/**
 * Let an EXISTING host's functions sign URLs (new hosts get this from the
 * provisioner, step 5c). One narrow binding, no console:
 *
 *   bun scripts/enable-signing.js --alias default --dry-run
 *   bun scripts/enable-signing.js --alias default
 *
 * Grants the functions' runtime service account "Service Account Token
 * Creator" on ITSELF (see grantSelfSigning in sandbox-lib.js), and lets
 * browsers read the signed responses (ensureSignedUrlCors).
 */
import * as lib from './sandbox-lib.js'

const { has, val } = lib.parseArgs(process.argv)
const alias = val('alias') ?? 'default'
const projectId = lib.readRc().projects?.[alias]
if (!projectId) {
  console.error(`No project for alias "${alias}" in .firebaserc`)
  process.exit(2)
}
const dry = has('dry-run')
const { account, changed } = await lib.grantSelfSigning(projectId, { dryRun: dry })
console.log(
  `${projectId}: ${account} ` +
    (changed ? (dry ? 'would be granted Token Creator on itself' : 'granted Token Creator on itself') : 'can already sign as itself')
)
// Signed redirects leave the site's origin; a page's fetch() must be allowed to read them.
const cors = await lib.ensureSignedUrlCors(projectId, { dryRun: dry })
console.log(
  `${projectId}: bucket ${cors.bucket} ` +
    (cors.changed ? (dry ? 'would allow cross-origin GET of signed URLs' : 'now allows cross-origin GET of signed URLs') : 'already allows cross-origin GET')
)
