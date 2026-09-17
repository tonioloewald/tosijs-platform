#!/usr/bin/env bun

/**
 * Wipe a sandbox back to a clean slate: delete every Firestore document, then
 * reseed from `initial_state/`.
 *
 * ## Why reset instead of recreate
 *
 * Deleting a Google Cloud project is a **30-day soft delete**, the project id is
 * **never reusable**, and pending-deletion projects still count against the
 * project-creation quota. Churning throwaway projects burns ids and quota fast.
 *
 * Resetting in place takes seconds, costs nothing, and — importantly — needs no
 * repeat of the one manual step (enabling Google sign-in in the console). It
 * also still produces genuine first-boot state for the install/claim-ceremony
 * work, which only cares that the nonce and role documents are absent.
 *
 * Reserve real teardown (`gcloud projects delete <id>`) for when you are done
 * with the sandbox entirely.
 *
 * ## Safety
 *
 * This runs `firestore:delete --all-collections --force`, which is the most
 * destructive command in this repo. Guards, all in `sandbox-lib.js`:
 *   - the target is named by `.firebaserc` ALIAS only, never a raw project id;
 *   - the alias `default` is refused;
 *   - a resolved id equal to the production id is refused;
 *   - the known-live project id is refused by name.
 * And, here: **dry run by default**, plus a typed confirmation unless `--force`.
 *
 * ## Usage
 *
 *   bun scripts/reset-sandbox.js                 # dry run
 *   bun scripts/reset-sandbox.js --apply         # prompts for confirmation
 *   bun scripts/reset-sandbox.js --apply --force # no prompt (for scripts)
 *   bun scripts/reset-sandbox.js --apply --no-seed
 */

import readline from 'readline'
import {
  FIREBASE,
  resolveSandbox,
  productionProjectId,
  run,
  parseArgs,
} from './sandbox-lib.js'

const { has, val } = parseArgs(process.argv)
const APPLY = has('apply')
const FORCE = has('force')
const NO_SEED = has('no-seed')
const ALIAS = val('alias') ?? 'sandbox'

const dry = !APPLY

const confirm = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })

async function main() {
  // Throws on anything production-shaped, before we do anything at all.
  const { projectId } = resolveSandbox(ALIAS)

  console.log(
    `\n${dry ? 'DRY RUN' : 'APPLYING'} — reset sandbox "${ALIAS}" (${projectId})`
  )
  console.log(`Production is "${productionProjectId()}" and is not touched.`)
  console.log(
    '\nThis DELETES EVERY DOCUMENT in that project\'s Firestore database' +
      (NO_SEED ? '.' : ', then reseeds from initial_state/.')
  )

  if (!dry && !FORCE) {
    const answer = await confirm(
      `\nType the project id to confirm (${projectId}): `
    )
    if (answer !== projectId) {
      console.log('Mismatch — aborted. Nothing was deleted.')
      process.exit(1)
    }
  }

  console.log('\n[1] Delete all Firestore documents')
  run(`${FIREBASE} firestore:delete --all-collections --force -P ${ALIAS}`, {
    dryRun: dry,
  })

  if (!NO_SEED) {
    console.log('\n[2] Reseed from initial_state/')
    run(`bun scripts/seed-production.js --project ${projectId} --force`, {
      dryRun: dry,
    })
  }

  console.log(
    dry
      ? '\nDRY RUN — nothing was deleted. Re-run with --apply.'
      : `\nSandbox "${ALIAS}" reset.`
  )
}

main().catch((e) => {
  console.error(`\nreset-sandbox failed: ${e.message}`)
  process.exit(1)
})
