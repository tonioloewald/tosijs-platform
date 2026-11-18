/**
 * Game rooms on the Bun host (D26), end to end: real WebSockets to
 * `serve.ts`, membership read from a `room` document in SQLite, dev tokens.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { serveLocal, type LocalHost } from './serve'
import { dataStore } from '../../datastore'
import { devToken } from '../local/identity'
import { CLOSE } from '../../rooms/relay'

interface Client {
  ws: WebSocket
  messages: Array<Record<string, unknown>>
  closed: Promise<{ code: number; reason: string }>
  next(type: string): Promise<Record<string, unknown>>
  send(message: unknown): void
}

describe('rooms on the Bun host', () => {
  let dir = ''
  let host: LocalHost

  const open = (token: string, room = 'match-1', path = '/rooms'): Promise<Client> =>
    new Promise((ready, fail) => {
      const ws = new WebSocket(host.url.replace('http', 'ws') + path)
      const messages: Array<Record<string, unknown>> = []
      const waiting: Array<{ type: string; done: (m: Record<string, unknown>) => void }> = []
      const closed = new Promise<{ code: number; reason: string }>((done) =>
        ws.addEventListener('close', (e) => done({ code: e.code, reason: e.reason }))
      )
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(String(e.data))
        messages.push(m)
        const i = waiting.findIndex((w) => w.type === m.type)
        if (i >= 0) waiting.splice(i, 1)[0].done(m)
      })
      ws.addEventListener('error', () => fail(new Error('socket error')))
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'join', room, token }))
        ready({
          ws,
          messages,
          closed,
          send: (m) => ws.send(JSON.stringify(m)),
          next: (type) => {
            const seen = messages.find((m) => m.type === type)
            if (seen) {
              messages.splice(messages.indexOf(seen), 1)
              return Promise.resolve(seen)
            }
            return new Promise((done) => waiting.push({ type, done }))
          },
        })
      })
    })

  const ada = devToken({ sub: 'ada' })
  const bob = devToken({ sub: 'bob' })
  const eve = devToken({ sub: 'eve' })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rooms-'))
    host = await serveLocal({ dataDir: dir, port: 0 })
    await dataStore.set('room/match-1', {
      members: ['ada', 'bob'],
      limits: { messageBytes: 256 },
      expires: new Date(Date.now() + 3600e3).toJSON(),
    })
  })
  afterAll(async () => {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('two members join and relay to each other', async () => {
    const a = await open(ada)
    expect(await a.next('joined')).toEqual({ type: 'joined', room: 'match-1', you: 'ada', members: ['ada'] })
    const b = await open(bob)
    expect((await b.next('joined')).members).toEqual(['ada', 'bob'])
    expect(await a.next('presence')).toEqual({ type: 'presence', joined: 'bob' })
    b.send({ type: 'send', data: { pos: [1, 2, 3] } })
    expect(await a.next('message')).toEqual({ type: 'message', from: 'bob', data: { pos: [1, 2, 3] } })
    b.ws.close()
    expect(await a.next('presence')).toEqual({ type: 'presence', left: 'bob' })
    a.ws.close()
  })

  test('a non-member, a bad token and a missing room are all refused the same way', async () => {
    for (const [token, room] of [
      [eve, 'match-1'],
      ['not-a-token', 'match-1'],
      [ada, 'no-such-room'],
    ]) {
      const c = await open(token, room)
      const { code } = await c.closed
      expect(code).toBe(CLOSE.refused)
    }
    const nonMember = await open(eve)
    expect(await nonMember.next('refused')).toEqual({ type: 'refused', reason: 'not a member of this room' })
  })

  test("the room's message limit holds over the wire", async () => {
    const a = await open(ada)
    await a.next('joined')
    a.send({ type: 'send', data: 'x'.repeat(400) })
    expect((await a.closed).code).toBe(CLOSE.tooBig)
  })

  test('removing a member closes their socket', async () => {
    const a = await open(ada)
    await a.next('joined')
    host.rooms.relay.revoke('match-1', 'ada')
    expect((await a.closed).code).toBe(CLOSE.revoked)
  })

  test('the whole flow: make a room, share its code, play, be removed', async () => {
    const room = (method: string, token: string | null, body?: unknown, query = '') =>
      fetch(`${host.url}/demo-local/us-central1/room${query}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    expect((await room('POST', null, {})).status).toBe(401)
    const madeResponse = await room('POST', ada, { maxMembers: 4 })
    expect(madeResponse.status).toBe(201)
    const made = await madeResponse.json()
    expect(made).toMatchObject({ creator: 'ada', members: ['ada'], maxMembers: 4 })

    expect((await room('PUT', bob, { id: made.id, code: 'WRONGCOD' })).status).toBe(404)
    expect((await room('PUT', bob, { id: made.id, code: made.code })).status).toBe(200)
    // Room documents are closed to /doc: no config, deny by default.
    expect((await fetch(`${host.url}/demo-local/us-central1/doc?p=room/${made.id}`, { headers: { Authorization: `Bearer ${ada}` } })).status).toBe(404)

    const a = await open(ada, made.id)
    await a.next('joined')
    const b = await open(bob, made.id)
    await b.next('joined')
    expect(await a.next('presence')).toEqual({ type: 'presence', joined: 'bob' })
    b.send({ type: 'send', data: 'hello' })
    expect(await a.next('message')).toEqual({ type: 'message', from: 'bob', data: 'hello' })

    expect((await room('DELETE', ada, undefined, `?id=${made.id}&uid=bob`)).status).toBe(200)
    expect((await b.closed).code).toBe(CLOSE.revoked)
    expect(await a.next('presence')).toEqual({ type: 'presence', left: 'bob' })

    expect((await room('DELETE', ada, undefined, `?id=${made.id}`)).status).toBe(200)
    expect((await a.closed).code).toBe(CLOSE.revoked)
  })

  test('no socket anywhere but /rooms', async () => {
    await expect(open(ada, 'match-1', '/elsewhere')).rejects.toThrow()
  })
})
