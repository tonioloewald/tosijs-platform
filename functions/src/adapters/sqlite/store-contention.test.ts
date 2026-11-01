/**
 * SQLite under several PROCESSES on one file: the multi-worker Bun server's
 * situation. One writer at a time (SQLite's lock), and a process waiting for
 * that lock keeps serving: it sleeps and retries rather than blocking its
 * event loop (store.ts, "Waiting for the lock never blocks the process").
 *
 * Run: cd functions && bun test src/adapters/sqlite/store-contention.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { spawn } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { SqliteStore } from './store'

const WORKER = join(__dirname, 'contention-worker.ts')
let dir = ''
let file = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqlite-contention-'))
  file = join(dir, 'host.db')
  new SqliteStore(file).close() // create the schema once, before the race
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Start a worker process; `ready` resolves at its first output line, `done` with its JSON result. */
function worker(role: string, arg = '') {
  const child = spawn(process.execPath, [WORKER, file, role, arg], { stdio: ['ignore', 'pipe', 'inherit'] })
  const lines: string[] = []
  let readyResolve: () => void
  const ready = new Promise<void>((resolve) => (readyResolve = resolve))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    lines.push(...chunk.split('\n').filter(Boolean))
    readyResolve()
  })
  const done = new Promise<Record<string, unknown>>((resolve) =>
    child.on('exit', () => resolve(JSON.parse(lines[lines.length - 1] ?? '{}')))
  )
  return { ready, done }
}

test('four processes, 400 transactional increments: none lost, one create wins', async () => {
  const results = await Promise.all([1, 2, 3, 4].map(() => worker('count', '100').done))
  for (const r of results) expect(r.error).toBeUndefined()
  const store = new SqliteStore(file)
  expect((await store.get('counter/c')).data).toEqual({ n: 400 })
  expect(results.reduce((sum, r) => sum + (r.won as number), 0)).toBe(1)
  store.close()
}, 60000)

test('a process waiting for the lock keeps its event loop and its reads', async () => {
  const hold = worker('hold', '600')
  await hold.ready // the lock is taken
  const waiting = await worker('wait').done
  await hold.done
  expect(waiting.error).toBeUndefined()
  // It did wait for the holder…
  expect(waiting.waitedMs as number).toBeGreaterThan(300)
  // …without freezing: timers kept firing and a read went straight through.
  expect(waiting.ticks as number).toBeGreaterThan(20)
  expect(waiting.readMs as number).toBeLessThan(100)
}, 30000)
