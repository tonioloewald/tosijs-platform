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

/**
 * The PLATFORM surface — what a consumer host actually needs (#21).
 *
 * A consumer provisioning a host for their own library was getting all of
 * loewald.com besides: fourteen public Cloud Run services, two placeholder
 * secrets for an LLM endpoint they never asked for, and a blog's seed data.
 * None of it broke anything; all of it is theirs to wonder about, and a
 * function list a host's owner cannot account for is a security surface they
 * cannot reason about.
 *
 * `hello` is in the list deliberately, despite reading like site furniture: it
 * is the only "what roles do I have?" probe, and #19 established that an agent
 * has to be able to ask. `stored` is NOT, for the same reason it is excluded
 * from the invoker bindings — storage.rules still allows world reads on
 * user-scoped paths (#3).
 */
export const PLATFORM_FUNCTIONS = [
  'doc',
  'docs',
  'user',
  'hello',
  'claim',
  'install',
  'token',
  'authorize',
]

/** Everything else this repo deploys — loewald.com's own surface. */
export const SITE_FUNCTIONS = [
  'prefetch',
  'prefetchData',
  'sitemap',
  'esm',
  'cachedQuery',
  'stored',
  'gen',
]

/**
 * A host records WHOSE it is, at `system:host/identity` (#23).
 *
 * `resolveSandbox()` only ever asked "is this production?". That cannot tell a
 * throwaway project the maintainer made to test on from a host somebody else
 * is using — and the difference matters enormously, because the verify scripts
 * mint privileged principals, delete role documents and install libraries.
 *
 * Run against a consumer's host, `verify-install.js` deleted that consumer's
 * `configurator` role document: it mints `sandbox-installer@example.test`,
 * which is the SAME deterministic identity the consumer had used to claim,
 * because `sandbox-token.js` is the documented way to get an ID token. The
 * verifier could not tell the consumer's principal from its own.
 *
 * `system:host` is unregistered, so deny-default keeps it out of /doc.
 */
export const HOST_IDENTITY = { collection: 'system:host', doc: 'identity' }

export const readHostPurpose = async (projectId) => {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
      `/databases/(default)/documents/${encodeURIComponent(HOST_IDENTITY.collection)}/${HOST_IDENTITY.doc}`,
    { headers: { Authorization: `Bearer ${token()}` } }
  )
  if (!res.ok) return null
  const json = await res.json().catch(() => null)
  return json?.fields?.purpose?.stringValue ?? null
}

/**
 * Refuse to run a destructive probe against somebody else's host.
 *
 * Fails CLOSED on an UNMARKED host too: every host provisioned before this
 * existed is unmarked, and one of them turned out to be a consumer's. "I could
 * not tell" must not read as "go ahead".
 */
export const assertProbeAllowed = async (projectId, argv = process.argv) => {
  if (argv.includes('--i-own-this-host')) return
  const purpose = await readHostPurpose(projectId)
  if (purpose === 'platform-sandbox') return
  console.error(
    `\nRefusing to run against ${projectId}.\n\n` +
      (purpose === 'consumer'
        ? '  This host is marked `consumer` — somebody is using it. These\n' +
          '  scripts mint privileged principals, delete role documents and\n' +
          '  install libraries.\n'
        : '  This host carries no `system:host/identity` marker, so it cannot be\n' +
          '  shown to be a throwaway. Unmarked fails closed: every host made\n' +
          '  before the marker existed is unmarked, and one of them was a\n' +
          "  consumer's.\n") +
      '\n  If it really is yours to wreck:\n' +
      '    --i-own-this-host\n'
  )
  process.exit(1)
}

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
