/**
 * The Store conformance suite (collections/store.suite.ts) against SqliteStore,
 * on an in-memory database per store: no emulator, no files, no network.
 *
 * Run: cd functions && bun test src/adapters/sqlite/store.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { test, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

import { storeConformance } from '../../collections/store.suite'
import { SqliteStore } from './store'

storeConformance('SQLite', {
  async make(seed = {}, keys = {}) {
    const store = new SqliteStore(':memory:', keys)
    for (const [path, data] of Object.entries(seed)) await store.set(path, data)
    return store
  },
})

// The Node build (tsconfig.json) excludes this adapter, since Cloud Functions
// cannot load `bun:sqlite`; tsconfig.bun.json typechecks it against Bun's
// types instead, and this keeps that check from being forgotten.
test('the SQLite adapter typechecks under Bun’s types', () => {
  const root = join(__dirname, '../../..')
  const tsc = spawnSync(
    join(root, 'node_modules/.bin/tsc'),
    ['-p', 'tsconfig.bun.json'],
    { cwd: root, encoding: 'utf8' }
  )
  expect(tsc.stdout + tsc.stderr).toBe('')
  expect(tsc.status).toBe(0)
}, 30000)

test('a file database keeps its documents across close and reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-store-'))
  try {
    const file = join(dir, 'host.db')
    const first = new SqliteStore(file)
    await first.set('post/a', { path: 'hello', tags: ['x'] })
    await first.transaction(async (tx) => {
      tx.set('post/a', { seen: true }, { merge: true })
    })
    first.close()
    const second = new SqliteStore(file, { unique: { post: ['path'] } })
    expect(await second.get('post/a')).toEqual({
      path: 'post/a',
      exists: true,
      data: { path: 'hello', tags: ['x'], seen: true },
    })
    expect(await second.resolve('post/path=hello')).toBe('post/a')
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the SQLite datastore resolves field=value with each request’s collection map', async () => {
  const { sqliteDataStore } = await import('./datastore')
  const host = sqliteDataStore(':memory:')
  await host.store.set('post/a', { path: 'hello', tags: ['t'] })
  await host.store.set('lib:task/b', { slug: 'x' })
  const platform = host.storeFor({ post: { access: {}, unique: ['path'] } })
  expect(await platform.resolve('post/path=hello')).toBe('post/a')
  // An installed collection's keys exist only in a map that includes it.
  expect(await platform.resolve('lib:task/slug=x')).toBeInstanceOf(Error)
  const merged = host.storeFor({ 'lib:task': { access: {}, unique: ['slug'] } })
  expect(await merged.resolve('lib:task/slug=x')).toBe('lib:task/b')
  host.close()
})
