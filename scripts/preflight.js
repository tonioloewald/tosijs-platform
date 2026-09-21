#!/usr/bin/env bun

/**
 * The publish gate, made readable.
 *
 * `prepublishOnly` ran the suites directly, and a successful publish printed
 * well over a hundred lines of red: skip guards announcing that emulator
 * suites did not run, fail-closed paths logging the denial they exist to log,
 * and a connection refused for every emulator probe. All expected. All
 * indistinguishable, at a glance, from something going wrong.
 *
 * That is the same failure as a dry run reporting fourteen changes when the
 * answer is zero — it teaches you to stop reading the thing whose only job is
 * to be read. So: run everything, show the verdict, and surface the detail
 * ONLY when a step fails, where it is the whole point.
 *
 * Nothing is suppressed on failure. `--verbose` shows everything always.
 */

import { execSync } from 'child_process'
import path from 'path'

const root = path.resolve(import.meta.dir, '..')
const VERBOSE = process.argv.includes('--verbose')

const steps = [
  { name: 'build the published library', cmd: 'bun run build:lib' },
  { name: 'typecheck', cmd: 'bun run typecheck' },
  { name: 'client tests', cmd: 'bun test' },
  { name: 'functions tests', cmd: 'bun test', cwd: path.join(root, 'functions') },
  { name: 'functions lint', cmd: 'npm run lint', cwd: path.join(root, 'functions') },
  { name: 'the tarball imports', cmd: 'bun scripts/verify-package.js' },
]

let failed = 0
for (const step of steps) {
  const started = Date.now()
  try {
    // `2>&1` because bun writes its summary to STDERR, so a stdout-only
    // capture reported every step as passing with nothing to show — which is
    // precisely the kind of quietly-uninformative output this script exists
    // to stop producing.
    const out = execSync(`${step.cmd} 2>&1`, {
      cwd: step.cwd ?? root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // The test summary is the one line worth keeping from a passing run.
    const summary = (out.match(/^\s*\d+ (pass|fail).*$/gm) ?? []).join('  ').trim()
    console.log(
      `  ok  ${step.name}${summary ? ` — ${summary.replace(/\s+/g, ' ')}` : ''}` +
        `  (${((Date.now() - started) / 1000).toFixed(1)}s)`
    )
    if (VERBOSE) console.log(out)
  } catch (e) {
    failed += 1
    console.log(`FAIL  ${step.name}`)
    // Everything, unabridged. A failing step is exactly when the noise is the
    // signal.
    console.log(String(e.stdout ?? e.message))
    if (e.stderr) console.error(String(e.stderr))
  }
}

console.log(
  failed
    ? `\n${failed} of ${steps.length} preflight steps FAILED — not publishable\n`
    : `\nall ${steps.length} preflight steps passed\n`
)
process.exit(failed ? 1 : 0)
