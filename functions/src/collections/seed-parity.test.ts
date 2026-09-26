/**
 * Runs `seed-parity.isolated.ts` in its OWN process.
 *
 * That check loads `blog.ts`/`page.ts`, which initialise firebase-admin at
 * import, so it stubs firebase-admin first. `bun test` shares one process
 * across files, and once another file has loaded the real module the stub no
 * longer takes. A fresh process is the only way the stub is guaranteed to
 * come first — and running it from here means the parity check can never be
 * silently left out of `bun test`.
 */
import { test, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

test('seeded data configs decide exactly what the shipped TypeScript decides (isolated run)', () => {
  const run = spawnSync('bun', ['test', join(__dirname, 'seed-parity.isolated.ts')], {
    timeout: 55_000,
    killSignal: 'SIGKILL',
    encoding: 'utf-8',
    cwd: join(__dirname, '..', '..'),
  })
  const output = `${run.stdout}\n${run.stderr}`
  if (run.status !== 0) console.error(output)
  expect(run.status).toBe(0)
  // Not vacuous: the isolated file must actually have run its checks.
  expect(output).toMatch(/[1-9]\d* pass/)
  expect(output).toMatch(/\b0 fail/)
}, 60_000)
