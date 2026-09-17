#!/usr/bin/env bun

/**
 * Refuse to deploy a bundle that was built for a different Firebase project.
 *
 * ## The hole this closes
 *
 * `src/firebase-config.ts` is baked into the client bundle at build time, and
 * `firebase.json`'s hosting config has NO predeploy step — `firebase deploy
 * --only hosting` ships whatever happens to be sitting in `dist/`.
 *
 * So with two projects configured, this sequence is both natural and silently
 * catastrophic:
 *
 *     bun run use sandbox     # client config -> sandbox
 *     bun run build           # dist/ baked for sandbox
 *     bun run deploy-hosting  # -P default: ships SANDBOX client to PRODUCTION
 *
 * loewald.com would then read and WRITE the sandbox database. Nothing would
 * error; the site would just quietly be wrong. `bun run use` keeps the CLI and
 * the client config in agreement, but it cannot know what is already built —
 * only the artefact does.
 *
 * ## How
 *
 * Runs as a hosting `predeploy` hook, so it guards `firebase deploy` itself and
 * not merely the npm wrappers. firebase-tools sets `GCLOUD_PROJECT` to the
 * resolved deploy target; the built bundle names the project it was compiled
 * for. If they disagree, refuse and say exactly how to fix it.
 *
 * Refuses rather than silently rebuilding: a mismatch means the working tree is
 * pointed somewhere other than where you are deploying, and rebuilding would
 * paper over that while leaving `bun start` still talking to the other project.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const target =
  process.env.GCLOUD_PROJECT ||
  process.env.FIREBASE_PROJECT ||
  process.argv[2]

if (!target) {
  console.error(
    'assert-build-target: no deploy target (GCLOUD_PROJECT unset and no argument).'
  )
  process.exit(1)
}

const configPath = path.join(projectRoot, 'src', 'firebase-config.ts')
if (!fs.existsSync(configPath)) {
  console.error(
    `assert-build-target: ${path.relative(projectRoot, configPath)} is missing.\n` +
      `Run: bun run use <alias>`
  )
  process.exit(1)
}
const configured = (
  fs.readFileSync(configPath, 'utf-8').match(/const PROJECT_ID\s*=\s*['"]([^'"]+)['"]/) ?? []
)[1]

const bundlePath = path.join(projectRoot, 'dist', 'index.js')
if (!fs.existsSync(bundlePath)) {
  console.error(
    'assert-build-target: dist/index.js is missing — nothing has been built.\n' +
      '  bun run build'
  )
  process.exit(1)
}
const bundle = fs.readFileSync(bundlePath, 'utf-8')
const builtFor = bundle.includes(target) ? target : configured

const problems = []
if (configured !== target) {
  problems.push(
    `src/firebase-config.ts is set to "${configured}" but the deploy target is "${target}"`
  )
}
if (!bundle.includes(target)) {
  problems.push(
    `dist/index.js does not mention "${target}" — it appears to be built for "${builtFor}"`
  )
}

if (problems.length) {
  console.error(
    '\n' +
      '='.repeat(72) +
      '\nREFUSING TO DEPLOY — the built client does not match the deploy target.\n' +
      '='.repeat(72) +
      '\n\n' +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\n\n' +
      'Deploying this would point the deployed site at the wrong project: it\n' +
      'would read and write the other database, with no error to notice.\n\n' +
      'Fix:\n' +
      `  bun run use ${target === configured ? '<alias>' : 'default'}   # or the alias for ${target}\n` +
      '  bun run build\n' +
      '  ...then deploy again\n'
  )
  process.exit(1)
}

console.log(`assert-build-target: dist/ is built for ${target} — OK`)
