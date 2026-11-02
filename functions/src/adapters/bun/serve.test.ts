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

  test('/__dev/login lists role documents and signs the browser in as one', async () => {
    const list = await fetch(`${host.url}/__dev/login`)
    expect(list.status).toBe(200)
    expect(list.headers.get('x-dev-login')).toBe('1')
    const html = await list.text()
    expect(html).toContain('local-owner')
    const as = await (await fetch(`${host.url}/__dev/login?uid=local-owner&email=owner@example.invalid`)).text()
    const token = /localStorage\.setItem\("dev-identity-token", "([^"]+)"\)/.exec(as)?.[1]
    expect(token).toBeTruthy()
    // The token it hands out is one the host honours, with the role it shows.
    const me = await fetch(`${host.url}/demo-local/us-central1/user`, { headers: { Authorization: `Bearer ${token}` } })
    expect((await me.json()).roles).toContain('owner')
    expect(await (await fetch(`${host.url}/__dev/login?signout`)).text()).toContain('localStorage.removeItem')
  })

  test('the page escapes what it shows', async () => {
    await dataStore.set('role/xss', { name: '<script>alert(1)</script>', roles: [], userIds: ['u"x'], contacts: [] })
    const html = await (await fetch(`${host.url}/__dev/login`)).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&#60;script&#62;')
  })
})

test('without dev identities there is no dev sign-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serve-nodev-'))
  const host = await serveLocal({ dataDir: dir, port: 0, devIdentities: false, firebaseJson: FIREBASE_JSON })
  try {
    const res = await fetch(`${host.url}/__dev/login`)
    expect(res.headers.get('x-dev-login')).toBeNull()
    expect(await res.text()).not.toContain('dev-identity-token')
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
