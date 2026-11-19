/**
 * Making rooms and managing their members (D26), on an in-memory store with a
 * fake clock: who may do what, and what non-members can learn.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryStore } from '../collections/store'
import {
  createRoom,
  joinRoom,
  getRoom,
  removeMember,
  closeRoom,
  setRoomRevoker,
  sweepExpiredRooms,
  MAX_OPEN_ROOMS,
  MAX_MEMBERS,
  ROOM_LIFETIME_MS,
  type RoomDeps,
  type RoomView,
  type Revoker,
} from './rooms'
import { HOST_LIMITS } from './relay'

let deps: RoomDeps
let clock: number
let revoked: Array<[string, string | undefined]>
let previous: Revoker

beforeEach(() => {
  clock = Date.parse('2026-11-18T12:00:00Z')
  let n = 0
  deps = { store: new MemoryStore(), now: () => clock, randomId: (length) => `id${++n}`.padEnd(length, 'x') }
  revoked = []
  previous = setRoomRevoker((room, uid) => revoked.push([room, uid]))
})
afterEach(() => setRoomRevoker(previous))

const made = async (uid = 'ada', body: Record<string, unknown> = {}) => {
  const r = await createRoom(uid, body, deps)
  if (!r.ok) throw new Error(r.message)
  return r.value
}
const joined = async (uid: string, room: RoomView) => joinRoom(uid, { id: room.id, code: room.code }, deps)

describe('making a room', () => {
  test('the creator is its first member, and alone sees the code', async () => {
    const room = await made()
    expect(room).toMatchObject({ creator: 'ada', members: ['ada'], maxMembers: 8, limits: HOST_LIMITS })
    expect(room.code).toHaveLength(8)
    expect(room.expires).toBe(new Date(clock + ROOM_LIFETIME_MS).toJSON())
    await joined('bob', room)
    const bobSees = await getRoom('bob', room.id, deps)
    expect(bobSees.ok && bobSees.value.code).toBeUndefined()
  })

  test('limits and size are checked; a room asks for lower limits, never higher', async () => {
    expect(await createRoom('ada', { maxMembers: MAX_MEMBERS + 1 }, deps)).toMatchObject({ ok: false, status: 400 })
    expect(await createRoom('ada', { maxMembers: 2.5 }, deps)).toMatchObject({ ok: false, status: 400 })
    expect(await createRoom('ada', { limits: 'fast' }, deps)).toMatchObject({ ok: false, status: 400 })
    const room = await made('ada', { limits: { messageBytes: 100, perSecond: 1000 } })
    expect(room.limits).toEqual({ messageBytes: 100, perSecond: HOST_LIMITS.perSecond })
  })

  test(`at most ${MAX_OPEN_ROOMS} open rooms each; expired ones do not count, and are removed`, async () => {
    for (let i = 0; i < MAX_OPEN_ROOMS; i++) await made()
    expect(await createRoom('ada', {}, deps)).toMatchObject({ ok: false, status: 403 })
    expect((await createRoom('bob', {}, deps)).ok).toBe(true)
    clock += ROOM_LIFETIME_MS + 1
    expect((await createRoom('ada', {}, deps)).ok).toBe(true)
    expect((await deps.store.query('room', { equals: { field: 'creator', value: 'ada' }, orderBy: '~' })).length).toBe(1)
  })
})

describe('joining', () => {
  test('with the code; joining twice changes nothing', async () => {
    const room = await made()
    expect(await joined('bob', room)).toMatchObject({ ok: true, value: { members: ['ada', 'bob'] } })
    expect(await joined('bob', room)).toMatchObject({ ok: true, value: { members: ['ada', 'bob'] } })
  })

  test('a wrong code, a wrong id and an expired room look the same: not found', async () => {
    const room = await made()
    const answers = [
      await joinRoom('bob', { id: room.id, code: 'WRONGCOD' }, deps),
      await joinRoom('bob', { id: 'nope', code: room.code }, deps),
      await joinRoom('bob', { id: '../role/x', code: room.code }, deps),
      await joinRoom('bob', { id: room.id }, deps),
    ]
    clock += ROOM_LIFETIME_MS
    answers.push(await joined('bob', room))
    for (const a of answers) expect(a).toEqual({ ok: false, status: 404, error: 'not-found', message: 'not found' })
  })

  test('a full room refuses', async () => {
    const room = await made('ada', { maxMembers: 2 })
    expect((await joined('bob', room)).ok).toBe(true)
    expect(await joined('cy', room)).toMatchObject({ ok: false, status: 403, message: 'the room is full' })
  })
})

describe('seeing a room', () => {
  test('members only; to anyone else it does not exist', async () => {
    const room = await made()
    expect((await getRoom('ada', room.id, deps)).ok).toBe(true)
    expect(await getRoom('eve', room.id, deps)).toMatchObject({ ok: false, status: 404 })
  })
})

describe('leaving and removing', () => {
  test('a member leaves; their connection is closed', async () => {
    const room = await made()
    await joined('bob', room)
    expect(await removeMember('bob', room.id, 'bob', deps)).toMatchObject({ ok: true, value: { members: ['ada'] } })
    expect(revoked).toEqual([[room.id, 'bob']])
  })

  test('the creator removes others; members cannot', async () => {
    const room = await made()
    await joined('bob', room)
    await joined('cy', room)
    expect(await removeMember('bob', room.id, 'cy', deps)).toMatchObject({ ok: false, status: 403 })
    expect(revoked).toEqual([])
    expect(await removeMember('ada', room.id, 'cy', deps)).toMatchObject({ ok: true, value: { members: ['ada', 'bob'] } })
    expect(revoked).toEqual([[room.id, 'cy']])
  })

  test('the creator cannot leave, only close; a non-member learns nothing', async () => {
    const room = await made()
    expect(await removeMember('ada', room.id, 'ada', deps)).toMatchObject({ ok: false, status: 403 })
    expect(await removeMember('eve', room.id, 'ada', deps)).toMatchObject({ ok: false, status: 404 })
  })

  test('closing: the creator only; the room is gone and every connection closed', async () => {
    const room = await made()
    await joined('bob', room)
    expect(await closeRoom('bob', room.id, deps)).toMatchObject({ ok: false, status: 403 })
    expect(await closeRoom('ada', room.id, deps)).toEqual({ ok: true, value: { id: room.id } })
    expect(revoked).toEqual([[room.id, undefined]])
    expect((await deps.store.get(`room/${room.id}`)).exists).toBe(false)
  })
})

describe('sweeping', () => {
  test('expired rooms are deleted and their connections closed; open ones stay', async () => {
    const old = await made('ada')
    clock += ROOM_LIFETIME_MS / 2
    const young = await made('bob')
    clock += ROOM_LIFETIME_MS / 2
    expect(await sweepExpiredRooms(deps)).toBe(1)
    expect(revoked).toEqual([[old.id, undefined]])
    expect((await deps.store.get(`room/${old.id}`)).exists).toBe(false)
    expect((await deps.store.get(`room/${young.id}`)).exists).toBe(true)
    expect(await sweepExpiredRooms(deps)).toBe(0)
  })
})
