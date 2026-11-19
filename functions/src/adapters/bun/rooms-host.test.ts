/**
 * The rooms host (D26, v1) end to end: guest tokens, /room and the socket on
 * one server, and nothing else reachable.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { serveRooms, type RoomsHost } from './rooms-host'

const CLIENT = '198.51.100.7'

describe('the rooms host', () => {
  let dir = ''
  let host: RoomsHost

  const call = (path: string, method = 'GET', token?: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${host.url}${path}`, {
      method,
      // As Caddy sends it: rate limits count per client address, process-wide.
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': CLIENT, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const guest = async (name?: string) => {
    const r = await call('/guest', 'POST', undefined, name ? { name } : {})
    expect(r.status).toBe(201)
    return (await r.json()) as { uid: string; name: string; token: string }
  }
  const socket = (token: string, room: string) =>
    new Promise<{ ws: WebSocket; next:() => Promise<Record<string, unknown>> }>((ready) => {
      const ws = new WebSocket(host.url.replace('http', 'ws') + '/rooms')
      const queue: Array<Record<string, unknown>> = []
      const waiting: Array<(m: Record<string, unknown>) => void> = []
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(String(e.data))
        const w = waiting.shift()
        if (w) w(m)
        else queue.push(m)
      })
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'join', room, token }))
        ready({ ws, next: () => {
            const m = queue.shift()
            return m ? Promise.resolve(m) : new Promise((done) => waiting.push(done))
          } })
      })
    })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rooms-host-'))
    host = await serveRooms({ dataDir: join(dir, 'data'), port: 0 })
  })
  afterAll(async () => {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('the guest secret is owner-only', () => {
    expect(statSync(join(dir, 'data', 'guest-secret')).mode & 0o777).toBe(0o600)
  })

  test('two agents: get guests, make a room, join with the code, relay', async () => {
    const [a, b] = [await guest('Agent A'), await guest()]
    expect((await call('/room', 'POST', undefined, {})).status).toBe(401)
    const made = await (await call('/room', 'POST', a.token, { maxMembers: 2 })).json()
    expect(made).toMatchObject({ creator: a.uid, members: [a.uid], maxMembers: 2 })
    expect((await call('/room', 'PUT', b.token, { id: made.id, code: made.code })).status).toBe(200)

    const sa = await socket(a.token, made.id)
    expect(await sa.next()).toMatchObject({ type: 'joined', you: a.uid })
    const sb = await socket(b.token, made.id)
    expect(await sb.next()).toMatchObject({ type: 'joined', you: b.uid, members: [a.uid, b.uid] })
    expect(await sa.next()).toEqual({ type: 'presence', joined: b.uid })
    sb.ws.send(JSON.stringify({ type: 'send', data: { move: 'e4' } }))
    expect(await sa.next()).toEqual({ type: 'message', from: b.uid, data: { move: 'e4' } })
    sa.ws.close()
    sb.ws.close()
  })

  test('a bad guest name is refused; a forged token is anonymous', async () => {
    expect((await call('/guest', 'POST', undefined, { name: '<b>' })).status).toBe(400)
    expect((await call('/guest')).status).toBe(403) // POST only (optionsResponse)
    expect((await call('/room', 'POST', 'guest.e30.AAAA', {})).status).toBe(401)
  })

  test('guests are rate limited per client address', async () => {
    const limited = await serveRooms({ dataDir: join(dir, 'limited'), port: 0, guestRateLimit: { windowMs: 60_000, maxRequests: 2 } })
    try {
      const ask = () => fetch(`${limited.url}/guest`, { method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.99' } })
      expect([(await ask()).status, (await ask()).status, (await ask()).status]).toEqual([201, 201, 429])
    } finally {
      await limited.close()
    }
    // closing the second host left the first's providers out; put them back
    await host.close()
    host = await serveRooms({ dataDir: join(dir, 'data'), port: 0 })
  })

  test('CORS: a game on another origin may call it', async () => {
    const r = await call('/guest', 'OPTIONS', undefined, undefined, { Origin: 'https://manta.example' })
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
  })

  test('nothing but rooms is bound', async () => {
    for (const path of ['/doc?p=room/x', '/docs', '/user', '/demo-local/us-central1/doc', '/']) {
      expect((await call(path)).status).toBe(404)
    }
    expect(await (await call('/health')).json()).toEqual({ ok: true })
  })

  test('a guest outlives a restart: the secret is kept', async () => {
    const a = await guest()
    await host.close()
    host = await serveRooms({ dataDir: join(dir, 'data'), port: 0 })
    expect((await call('/room', 'POST', a.token, {})).status).toBe(201)
  })
})
