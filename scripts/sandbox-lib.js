/**
 * Shared guards for the sandbox scripts.
 *
 * These scripts link billing, create databases, deploy, and — in the case of
 * `reset-sandbox.js` — run `firestore:delete --all-collections`, which is the
 * single most destructive command in this repo. Every guard that keeps them off
 * production lives HERE, in one file, so there is exactly one place to audit and
 * no chance of the two scripts disagreeing about what "production" means.
 *
 * The rule: a sandbox script must resolve its target through `resolveSandbox()`
 * and must never accept a bare project id from the command line. An alias in
 * `.firebaserc` is the only way to name a target, and the alias `default` is
 * refused outright.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const projectRoot = path.resolve(__dirname, '..')

export const FIREBASE = 'npx -y firebase-tools@latest'

export const readRc = () => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.firebaserc'), 'utf-8')
    )
  } catch {
    return { projects: {} }
  }
}

export const writeRc = (rc) =>
  fs.writeFileSync(
    path.join(projectRoot, '.firebaserc'),
    JSON.stringify(rc, null, 2) + '\n'
  )

/** The production project id. Anything equal to this is off limits, always. */
export const productionProjectId = () => readRc().projects?.default ?? null

/**
 * Resolve an alias to a project id, refusing anything that could be production.
 *
 * Four independent checks, because one guard is a typo away from being no guard:
 *   1. the alias may not be `default`;
 *   2. the alias must exist in `.firebaserc` (no bare project ids);
 *   3. the resolved id may not equal the production id;
 *   4. the resolved id must not be the known-live project, by name.
 *
 * (4) is belt-and-braces against someone "helpfully" repointing `default`.
 */
const KNOWN_PRODUCTION = 'liquid-force-425209-g2'

export function resolveSandbox(alias) {
  if (!alias || alias === 'default') {
    throw new Error(
      `Refusing to operate on alias "${alias ?? '(none)'}". ` +
        'Sandbox scripts never target the default/production project.'
    )
  }
  const projects = readRc().projects ?? {}
  const id = projects[alias]
  if (!id) {
    throw new Error(
      `No alias "${alias}" in .firebaserc. Known: ${Object.keys(projects).join(', ') || '(none)'}\n` +
        'Add it first — sandbox scripts will not accept a raw project id.'
    )
  }
  const prod = productionProjectId()
  if (id === prod) {
    throw new Error(
      `Alias "${alias}" resolves to "${id}", which is the DEFAULT (production) project. Refusing.`
    )
  }
  if (id === KNOWN_PRODUCTION) {
    throw new Error(
      `Alias "${alias}" resolves to the known production project "${KNOWN_PRODUCTION}". Refusing.`
    )
  }
  return { alias, projectId: id }
}

export const token = () =>
  execSync('gcloud auth print-access-token', {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { ok: res.ok, status: res.status, json }
}

export const run = (command, { dryRun, cwd = projectRoot } = {}) => {
  if (dryRun) {
    console.log(`   [dry-run] ${command}`)
    return null
  }
  console.log(`   $ ${command}`)
  return execSync(command, { cwd, stdio: 'inherit' })
}

export const capture = (command, { cwd = projectRoot } = {}) =>
  execSync(command, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })

export const parseArgs = (argv) => {
  const args = argv.slice(2)
  const has = (n) => args.includes(`--${n}`)
  const val = (n) => {
    const i = args.indexOf(`--${n}`)
    return i !== -1 ? args[i + 1] : undefined
  }
  return { args, has, val }
}

export const homeBackupRoot = (projectId) =>
  path.join(os.homedir(), 'Backups', 'tosijs-platform', projectId)
