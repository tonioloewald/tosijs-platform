/**
 * The whole platform on the Bun host (serve.ts): real endpoints, SQLite, a
 * directory and dev identities, with no Firebase and no emulators.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { serveLocal, type LocalHost } from './serve'
import { dataStore } from '../../datastore'
import { devToken } from '../local/identity'

const FIREBASE_JSON = join(__dirname, '../../../../firebase.json')

test('dev identities are refused on anything but loopback', async () => {
  await expect(serveLocal({ dataDir: tmpdir(), host: '0.0.0.0', port: 0 })).rejects.toThrow('unsigned')
})

test('a port in use: refuses, and leaves nothing installed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serve-busy-'))
  const first = await serveLocal({ dataDir: join(dir, 'a'), port: 0 })
  try {
    const port = Number(new URL(first.url).port)
    await expect(serveLocal({ dataDir: join(dir, 'b'), port })).rejects.toThrow()
    // The failed start uninstalled ITS datastore, so this one is gone too: nothing half-installed.
    await expect(dataStore.get('post/x')).rejects.toThrow('no datastore')
  } finally {
    await first.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('serving the platform from a data directory', () => {
  let dir = ''
  let host: LocalHost
  const fn = (name: string) => `${host.url}/demo-local/us-central1/${name}`
  const owner = devToken({ sub: 'local-owner', email: 'owner@example.invalid', email_verified: true })
  const start = async () => {
    host = await serveLocal({ dataDir: dir, port: 0, firebaseJson: FIREBASE_JSON })
  }
  const doc = (method: string, token: string | null, body?: unknown, query = '') =>
    fetch(`${fn('doc')}${query}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-local-'))
    await start()
    await dataStore.set('role/local-owner', {
      name: 'local-owner',
      roles: ['owner', 'developer', 'admin', 'editor', 'author'],
      userIds: ['local-owner'],
      contacts: [],
      // Role lookups order by `_created`, which (as on Firestore) skips documents without it.
      _created: new Date().toJSON(),
    })
  })
  afterAll(async () => {
    await host?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('an endpoint answers', async () => {
    expect((await fetch(fn('hello'))).status).toBe(200)
  })

  test('an anonymous write is refused, and writes nothing', async () => {
    const res = await doc('POST', null, { p: 'post/anon', data: { title: 'x', content: 'x', path: 'anon' } })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await dataStore.get('post/anon')).exists).toBe(false)
  })

  test('a forged (non-dev) token is anonymous', async () => {
    const res = await doc('POST', 'not-a-dev-token', { p: 'post/forged', data: { title: 'x', content: 'x', path: 'f' } })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await dataStore.get('post/forged')).exists).toBe(false)
  })

  test('a dev identity with a role writes through the write path, stamped', async () => {
    const res = await doc('POST', owner, { p: 'post/local-1', data: { title: 'Local', content: 'hi', path: 'local-1' } })
    expect(res.status).toBe(200)
    const read = await doc('GET', owner, undefined, '?p=post/local-1')
    expect(read.status).toBe(200)
    const body = await read.json()
    expect(body.title).toBe('Local')
    expect(typeof body._created).toBe('string')
  })

  test('/stored streams a legacy file from the directory, sandboxed by Hosting’s rule', async () => {
    mkdirSync(join(dir, 'files', 'blog'), { recursive: true })
    writeFileSync(join(dir, 'files', 'blog', 'note.svg'), '<svg/>')
    const res = await fetch(`${host.url}/stored/blog/note.svg`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<svg/>')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect((await fetch(`${host.url}/stored/private/x.txt`)).status).toBe(404)
  })

  test('documents survive a restart', async () => {
    await host.close()
    await start()
    const read = await doc('GET', owner, undefined, '?p=post/local-1')
    expect(read.status).toBe(200)
    expect((await read.json()).title).toBe('Local')
  })
})
