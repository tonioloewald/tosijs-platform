#!/usr/bin/env bun

/**
 * Switch which Firebase project this checkout talks to.
 *
 * ## Why this exists
 *
 * Pointing at a project is TWO pieces of state that must agree:
 *
 *   1. the **Firebase CLI** target — what `firebase deploy` writes to;
 *   2. `src/firebase-config.ts` — what the built client and `bun start` READ
 *      from (`projectId`, `apiKey`, `appId`, and the `PRODUCTION_BASE` function
 *      URL derived from them).
 *
 * Setting one and forgetting the other is the failure this script prevents, and
 * it fails in the worst possible direction: a client pointed at production while
 * the CLI deploys to a sandbox looks like "my changes did nothing", and the
 * reverse quietly writes sandbox test data into the live blog.
 *
 * `src/firebase-config.ts` is gitignored (see .gitignore), so per-project copies
 * live beside it as `src/firebase-config.<alias>.ts` and are also ignored. This
 * script copies the requested one into place and runs `firebase use <alias>`.
 *
 * ## Usage
 *
 *   bun run use                 # show current target
 *   bun run use sandbox         # switch to the sandbox project
 *   bun run use default         # switch back to production
 *
 * ## Adding a sandbox
 *
 *   1. Create the project (needs the **Blaze** plan — Cloud Functions v2 will
 *      not deploy on Spark):
 *        npx -y firebase-tools@latest projects:create tosijs-sandbox-XXXX
 *      then attach a billing account in the console.
 *   2. Register a Web App and copy its config into
 *      `src/firebase-config.sandbox.ts` (start from
 *      `src/firebase-config.example.ts`).
 *   3. Add the alias to `.firebaserc`:
 *        "projects": { "default": "...", "sandbox": "tosijs-sandbox-XXXX" }
 *   4. bun run use sandbox && bun run deploy:sandbox && bun run seed-production
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const rcPath = path.join(projectRoot, '.firebaserc')
const configPath = path.join(projectRoot, 'src', 'firebase-config.ts')
const variantPath = (alias) =>
  path.join(projectRoot, 'src', `firebase-config.${alias}.ts`)

const readAliases = () => {
  try {
    return JSON.parse(fs.readFileSync(rcPath, 'utf-8')).projects ?? {}
  } catch {
    return {}
  }
}

/** The projectId the CLIENT is currently built against. */
const currentClientProject = () => {
  if (!fs.existsSync(configPath)) return null
  const m = fs
    .readFileSync(configPath, 'utf-8')
    .match(/const PROJECT_ID\s*=\s*['"]([^'"]+)['"]/)
  return m ? m[1] : null
}

/** The alias the Firebase CLI currently has selected, if it can be determined. */
const currentCliProject = () => {
  try {
    return execSync('npx -y firebase-tools@latest use', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

const aliases = readAliases()
const alias = process.argv[2]

if (!alias) {
  const client = currentClientProject()
  console.log('Aliases in .firebaserc:')
  for (const [name, id] of Object.entries(aliases)) {
    console.log(`  ${name.padEnd(10)} ${id}${id === client ? '   <- client' : ''}`)
  }
  if (Object.keys(aliases).length < 2) {
    console.log(
      '\nOnly one project configured. See the header of this script to add a sandbox.'
    )
  }
  console.log(`\nClient (src/firebase-config.ts): ${client ?? 'MISSING'}`)
  console.log(`CLI:                             ${currentCliProject() ?? 'unknown'}`)
  console.log('\nUsage: bun run use <alias>')
  process.exit(0)
}

if (!aliases[alias]) {
  console.error(
    `No alias "${alias}" in .firebaserc. Known: ${Object.keys(aliases).join(', ') || '(none)'}`
  )
  process.exit(1)
}

const variant = variantPath(alias)
if (!fs.existsSync(variant)) {
  console.error(
    `Missing ${path.relative(projectRoot, variant)}.\n\n` +
      `Each project needs its own client config — apiKey, appId and\n` +
      `messagingSenderId are per-project and cannot be derived from the id.\n` +
      `Copy src/firebase-config.example.ts to that path and fill it in from:\n` +
      `  https://console.firebase.google.com/project/${aliases[alias]}/settings/general`
  )
  process.exit(1)
}

// Sanity check: the variant must actually name the project its alias points at.
// Copying a file that says "production" into place while switching to sandbox is
// exactly the mix-up this script exists to prevent, so refuse rather than warn.
const declared = (fs.readFileSync(variant, 'utf-8').match(
  /const PROJECT_ID\s*=\s*['"]([^'"]+)['"]/
) ?? [])[1]
if (declared !== aliases[alias]) {
  console.error(
    `${path.relative(projectRoot, variant)} declares PROJECT_ID "${declared}"\n` +
      `but .firebaserc maps alias "${alias}" to "${aliases[alias]}".\n` +
      'Refusing to switch — the client and the CLI would disagree.'
  )
  process.exit(1)
}

// PRESERVE whatever is in place before overwriting it.
//
// This destroyed the production config once (2026-09-17): `firebase-config.ts`
// held production, no `firebase-config.default.ts` existed, and switching to the
// sandbox overwrote it with nothing to switch back to. It is gitignored, so git
// could not restore it — the values had to be recovered from a source map and
// the deployed bundle.
//
// So: if the current config names a project that has an alias, and that alias
// has no variant file yet, save it as that variant first. Switching projects
// must never be able to lose one.
if (fs.existsSync(configPath)) {
  const current = currentClientProject()
  const currentAlias = Object.entries(aliases).find(
    ([, id]) => id === current
  )?.[0]
  if (currentAlias && !fs.existsSync(variantPath(currentAlias))) {
    fs.copyFileSync(configPath, variantPath(currentAlias))
    console.log(
      `preserved       -> firebase-config.${currentAlias}.ts (was in place, had no variant)`
    )
  } else if (!currentAlias) {
    // Names a project with no alias: keep it under its project id rather than
    // discarding it, since we cannot guess which alias it belongs to.
    const rescue = path.join(projectRoot, 'src', `firebase-config.${current}.ts`)
    if (current && !fs.existsSync(rescue)) {
      fs.copyFileSync(configPath, rescue)
      console.log(`preserved       -> firebase-config.${current}.ts (no alias for it)`)
    }
  }
}

fs.copyFileSync(variant, configPath)
console.log(`client config  -> ${aliases[alias]} (from firebase-config.${alias}.ts)`)

try {
  execSync(`npx -y firebase-tools@latest use ${alias}`, {
    cwd: projectRoot,
    stdio: 'inherit',
  })
} catch {
  console.error(
    `\nCould not set the CLI target. The client config WAS switched, so run:\n` +
      `  npx -y firebase-tools@latest use ${alias}`
  )
  process.exit(1)
}

console.log(
  `\nNow targeting "${alias}" (${aliases[alias]}).` +
    (alias === 'default'
      ? '  ** THIS IS PRODUCTION **'
      : '\nDeploy with: bun run deploy:' + alias)
)
