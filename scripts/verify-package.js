#!/usr/bin/env bun
/**
 * Prove the published tarball can actually be imported.
 *
 * `service-compris@0.1.0` could not be. The package is `"type": "module"`, and
 * TypeScript under `moduleResolution: "bundler"` emitted relative specifiers
 * with no `.js` extension — which Node's ESM loader refuses. Every local check
 * passed: it type-checked, it built, the tests were green, `npm pack` listed
 * the files. Nothing exercised the artifact the way a consumer would, so the
 * one thing that mattered went unnoticed through a whole release.
 *
 * So this packs the real tarball, unpacks it somewhere else, imports it as a
 * dependency, and calls something. It catches the extension bug, and also a
 * missing file, a bad `exports` map, and a stray import of a devDependency —
 * none of which a compiler flag would.
 *
 * Run: bun scripts/verify-package.js     (also runs from prepublishOnly)
 */
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const root = path.resolve(import.meta.dir, '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
const dir = mkdtempSync(path.join(tmpdir(), 'verify-package-'))
let failures = 0
const ok = (label, cond, detail = '') => {
  console.log(`${cond ? '  ok' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures += 1
}

try {
  execSync('npm run build:lib', { cwd: root, stdio: 'pipe' })
  const tgz = execSync('npm pack --pack-destination ' + dir, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().split('\n').pop()

  // INSTALL it, do not just untar it. A consumer runs `npm install`, which
  // resolves the exports map and pulls peer dependencies — `tosijs-schema` is
  // a peer here, so an untarred copy fails to resolve it and reports a
  // packaging bug that does not exist. Testing the wrong environment produces
  // confident wrong answers in both directions.
  const consumer = path.join(dir, 'consumer')
  execSync(`mkdir -p ${consumer}`, { stdio: 'pipe' })
  execSync('npm init -y', { cwd: consumer, stdio: 'pipe' })
  execSync(`npm install --no-audit --no-fund ${path.join(dir, tgz)}`, {
    cwd: consumer,
    stdio: 'pipe',
  })

  // Imported BY NAME, so the `exports` map is exercised too — not by a path
  // into the tree, which would pass even with a broken entry point.
  const probe = `
    import * as m from ${JSON.stringify(pkg.name)}
    const missing = ['runWritePipeline','getMethodAccess','ALL','ROLES']
      .filter((n) => m[n] === undefined)
    if (missing.length) { console.error('MISSING:' + missing.join(',')); process.exit(2) }
    const out = m.getMethodAccess(
      { thing: { access: { author: { read: m.ALL } } } },
      'thing', 'GET',
      { name: 'x', contacts: [], roles: ['author'], userIds: ['u'] }
    )
    if (out !== m.ALL) { console.error('WRONG:' + String(out)); process.exit(3) }
    console.log('OK:' + Object.keys(m).length)
  `
  // Written to a FILE rather than passed with `-e`: a multi-line program
  // through the shell gets mangled, and the resulting syntax error looks
  // exactly like a broken package — which is the failure this script exists
  // to report accurately.
  const probeFile = path.join(consumer, 'probe.mjs')
  writeFileSync(probeFile, probe)
  const result = execSync(`node ${probeFile}`, {
    cwd: consumer,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

  ok('the tarball installs, imports by name, and works', result.startsWith('OK:'), result)
} catch (e) {
  const detail = (e.stderr?.toString() || e.message || '').split('\n').slice(0, 4).join(' ')
  ok('the tarball imports and its exports work', false, detail)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(
  failures
    ? `\n${pkg.name}@${pkg.version} is NOT publishable\n`
    : `\n${pkg.name}@${pkg.version} imports cleanly\n`
)
process.exit(failures ? 1 : 0)
