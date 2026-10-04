#!/usr/bin/env bun
/**
 * Claim a host in one step (board #2489, D22).
 *
 *   bun scripts/claim.js --alias sandbox                 # arm for your gcloud account, open the page
 *   bun scripts/claim.js --alias default --for you@example.com
 *   bun scripts/claim.js --alias sandbox --no-open       # print the link instead
 *
 * What it does, with YOUR operator credentials (the same proof as the manual
 * ceremony: being able to write the datastore, D16):
 *   1. asks the host for its current claim nonce;
 *   2. writes that nonce into `system:claim/current` as the proof, BOUND to one
 *      email (`for`), so only that verified account can complete the claim;
 *   3. opens `/claim?page`, where that person signs in with Google and clicks
 *      Claim. Their account becomes the host's `configurator`.
 *
 * The nonce rotates on success, so this is also the break-glass path if the
 * configurator loses their account: run it again.
 *
 * Refuses a host marked `consumer` (somebody else's), like deploy.js.
 */
import { execSync } from 'child_process'
import * as lib from './sandbox-lib.js'

const { has, val } = lib.parseArgs(process.argv)
const alias = val('alias')
if (!alias) {
  console.error('usage: bun scripts/claim.js --alias <host> [--for <email>] [--no-open]')
  process.exit(2)
}
const projectId = lib.readRc().projects?.[alias]
if (!projectId) {
  console.error(`No project for alias "${alias}" in .firebaserc`)
  process.exit(2)
}
if (!has('i-own-this-host') && projectId !== lib.productionProjectId()) {
  const purpose = await lib.readHostPurpose(projectId)
  if (purpose !== 'platform-sandbox') {
    console.error(`Refusing to arm a claim on ${projectId} (${purpose ?? 'unmarked'}). If it really is yours: --i-own-this-host`)
    process.exit(1)
  }
}

const gcloudAccount = () => {
  try {
    return execSync('gcloud config get-value account 2>/dev/null', { encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}
const forEmail = (val('for') ?? gcloudAccount()).trim().toLowerCase()
if (!/^[^@\s]+@[^@\s]+$/.test(forEmail)) {
  console.error('Whose claim is this? Pass --for <email> (no gcloud account found to default to).')
  process.exit(2)
}

const base = `https://us-central1-${projectId}.cloudfunctions.net/claim`
const published = await fetch(base).then((r) => r.json())
if (!published?.nonce) {
  console.error(`The host did not publish a nonce: ${JSON.stringify(published).slice(0, 200)}`)
  process.exit(1)
}

// updateMask: write ONLY proof and for. Without it a PATCH replaces the whole
// document and wipes the nonce the proof has to match (BETA.md).
const doc =
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/` +
  `${encodeURIComponent('system:claim')}/current?updateMask.fieldPaths=proof&updateMask.fieldPaths=for`
const armed = await lib.api('PATCH', doc, {
  fields: { proof: { stringValue: published.nonce }, for: { stringValue: forEmail } },
})
if (!armed.ok) {
  console.error(`Could not write the proof (${armed.status}): ${JSON.stringify(armed.json).slice(0, 200)}`)
  process.exit(1)
}

const page = `${base}?page`
console.log(`${projectId}: claim armed for ${forEmail} (until ${published.expiresAt}).`)
console.log(`Sign in as that account and click Claim:\n  ${page}`)
if (!has('no-open')) {
  try {
    execSync(`open "${page}"`)
  } catch {
    // not macOS, or no browser: the link above is enough
  }
}
