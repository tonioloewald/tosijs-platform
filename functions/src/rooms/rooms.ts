/**
 * Making rooms and managing who is in them (D26). The socket only reads the
 * member list (membership.ts); this is the one place it is written.
 *
 * Room documents live in `room/<id>`. The collection has no config, so `/doc`
 * refuses every read and write of it (deny by default): the access vocabulary
 * cannot say "only this room's creator", and a room's code must never be
 * listed. The `/room` endpoint (room-endpoint.ts) calls these.
 *
 * ## The rules
 *
 * - Anyone signed in may make a room, and becomes its creator and first member.
 *   At most MAX_OPEN_ROOMS open rooms each.
 * - Others join with the room's code, while there is space and before it
 *   expires.
 * - The creator may remove anyone else, and close the room. A member may leave.
 *   Either way the host closes the removed member's connection at once.
 * - To anyone who is not a member, a room does not exist: a wrong code and a
 *   wrong id get the same answer.
 */
import { randomBytes, timingSafeEqual } from 'crypto'
import { dataStore, type DataStore } from '../datastore'
import { HOST_LIMITS, effectiveLimits, type RoomLimits } from './relay'
import { ROOM_COLLECTION, ROOM_ID } from './membership'

export const MAX_OPEN_ROOMS = 5
export const MAX_MEMBERS = 16
export const DEFAULT_MEMBERS = 8
export const ROOM_LIFETIME_MS = 24 * 3600 * 1000

export interface Room {
  creator: string
  members: string[]
  code: string
  maxMembers: number
  limits?: Partial<RoomLimits>
  _created: string
  expires: string
}

/** What a caller sees. Only the creator sees the code. */
export interface RoomView {
  id: string
  creator: string
  members: string[]
  maxMembers: number
  limits: RoomLimits
  expires: string
  code?: string
}

export type RoomResult<T> = { ok: true; value: T } | { ok: false; status: number; error: 'bad-request' | 'not-found' | 'refused'; message: string }

/** Closes connections when someone is removed; the host installs its own. */
export type Revoker = (room: string, uid?: string) => void

let revoker: Revoker = () => undefined

/** Install the host's revoker; returns the one it replaced. */
export function setRoomRevoker(r: Revoker | null): Revoker {
  const previous = revoker
  revoker = r ?? (() => undefined)
  return previous
}

export interface RoomDeps {
  store: Pick<DataStore, 'get' | 'set' | 'delete' | 'query' | 'transaction'>
  now: () => number
  randomId: (length: number) => string
}

// No 0/O, 1/l/I: a code is read aloud and typed.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
const randomId = (length: number): string => {
  const bytes = randomBytes(length * 2)
  let out = ''
  // Rejection sampling, so every character is equally likely.
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    if (bytes[i] < 256 - (256 % ALPHABET.length)) out += ALPHABET[bytes[i] % ALPHABET.length]
  }
  return out.length === length ? out : randomId(length)
}

const DEFAULT_DEPS: RoomDeps = { store: dataStore, now: Date.now, randomId }

const notFound = { ok: false as const, status: 404, error: 'not-found' as const, message: 'not found' }
const refused = (message: string) => ({ ok: false as const, status: 403, error: 'refused' as const, message })
const badRequest = (message: string) => ({ ok: false as const, status: 400, error: 'bad-request' as const, message })

const path = (id: string) => `${ROOM_COLLECTION}/${id}`

export const isOpen = (room: Pick<Room, 'expires'>, now: number) => Date.parse(room.expires) > now

const sameCode = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const view = (id: string, room: Room, uid: string): RoomView => ({
  id,
  creator: room.creator,
  members: room.members,
  maxMembers: room.maxMembers,
  limits: effectiveLimits(room.limits, HOST_LIMITS),
  expires: room.expires,
  ...(uid === room.creator ? { code: room.code } : {}),
})

/** A positive whole number, or absent; anything else is a bad request. */
const count = (value: unknown, name: string): number | undefined | Error => {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : new Error(`${name} must be a positive whole number`)
}

async function load(deps: RoomDeps, id: unknown, uid: string): Promise<{ id: string; room: Room } | null> {
  if (typeof id !== 'string' || !ROOM_ID.test(id)) return null
  const doc = await deps.store.get(path(id))
  if (!doc.exists) return null
  const room = doc.data as unknown as Room
  if (!isOpen(room, deps.now()) || !room.members.includes(uid)) return null
  return { id, room }
}

export async function createRoom(uid: string, body: Record<string, unknown>, deps = DEFAULT_DEPS): Promise<RoomResult<RoomView>> {
  const limitsIn = body.limits ?? {}
  if (typeof limitsIn !== 'object' || limitsIn === null || Array.isArray(limitsIn)) return badRequest('limits must be an object')
  const asked = limitsIn as Record<string, unknown>
  const numbers = {
    maxMembers: count(body.maxMembers, 'maxMembers'),
    messageBytes: count(asked.messageBytes, 'limits.messageBytes'),
    perSecond: count(asked.perSecond, 'limits.perSecond'),
  }
  for (const v of Object.values(numbers)) if (v instanceof Error) return badRequest(v.message)
  const { maxMembers, messageBytes, perSecond } = numbers as Record<keyof typeof numbers, number | undefined>
  if (maxMembers !== undefined && maxMembers > MAX_MEMBERS) return badRequest(`a room holds at most ${MAX_MEMBERS} members`)

  const now = deps.now()
  const mine = await deps.store.query(ROOM_COLLECTION, { equals: { field: 'creator', value: uid }, orderBy: '~' })
  const [open, expired] = [mine.filter((d) => isOpen(d.data as unknown as Room, now)), mine.filter((d) => !isOpen(d.data as unknown as Room, now))]
  // Expired rooms are no one's; tidy the caller's own while we are here.
  await Promise.all(expired.map((d) => deps.store.delete(d.path)))
  if (open.length >= MAX_OPEN_ROOMS) return refused(`at most ${MAX_OPEN_ROOMS} open rooms each; close one first`)

  const limits: Partial<RoomLimits> = {
    ...(messageBytes !== undefined ? { messageBytes } : {}),
    ...(perSecond !== undefined ? { perSecond } : {}),
  }
  const id = deps.randomId(16)
  const room: Room = {
    creator: uid,
    members: [uid],
    code: deps.randomId(8),
    maxMembers: maxMembers ?? DEFAULT_MEMBERS,
    ...(Object.keys(limits).length ? { limits } : {}),
    _created: new Date(now).toJSON(),
    expires: new Date(now + ROOM_LIFETIME_MS).toJSON(),
  }
  await deps.store.set(path(id), room as unknown as Record<string, unknown>)
  return { ok: true, value: view(id, room, uid) }
}

export async function joinRoom(uid: string, body: Record<string, unknown>, deps = DEFAULT_DEPS): Promise<RoomResult<RoomView>> {
  const { id, code } = body
  if (typeof id !== 'string' || !ROOM_ID.test(id) || typeof code !== 'string') return notFound
  return deps.store.transaction(async (tx): Promise<RoomResult<RoomView>> => {
    const doc = await tx.get(path(id))
    if (!doc.exists) return notFound
    const room = doc.data as unknown as Room
    if (!isOpen(room, deps.now()) || !sameCode(code, room.code)) return notFound
    if (room.members.includes(uid)) return { ok: true, value: view(id, room, uid) }
    if (room.members.length >= room.maxMembers) return refused('the room is full')
    const members = [...room.members, uid]
    tx.set(path(id), { members }, { merge: true })
    return { ok: true, value: view(id, { ...room, members }, uid) }
  })
}

export async function getRoom(uid: string, id: unknown, deps = DEFAULT_DEPS): Promise<RoomResult<RoomView>> {
  const found = await load(deps, id, uid)
  return found ? { ok: true, value: view(found.id, found.room, uid) } : notFound
}

/** Remove `who` (the creator removing someone, or a member leaving). */
export async function removeMember(uid: string, id: unknown, who: unknown, deps = DEFAULT_DEPS): Promise<RoomResult<RoomView>> {
  if (typeof who !== 'string' || !who) return badRequest('name the member to remove')
  if (typeof id !== 'string' || !ROOM_ID.test(id)) return notFound
  const result = await deps.store.transaction(async (tx): Promise<RoomResult<RoomView>> => {
    const doc = await tx.get(path(id))
    if (!doc.exists) return notFound
    const room = doc.data as unknown as Room
    if (!isOpen(room, deps.now()) || !room.members.includes(uid)) return notFound
    if (who !== uid && uid !== room.creator) return refused('only the creator removes others')
    if (who === room.creator) return refused('the creator closes the room instead of leaving it')
    if (!room.members.includes(who)) return { ok: true, value: view(id, room, uid) }
    const members = room.members.filter((m) => m !== who)
    tx.set(path(id), { members }, { merge: true })
    return { ok: true, value: view(id, { ...room, members }, uid) }
  })
  // After the commit: a connection is closed only once the list no longer admits it.
  if (result.ok) revoker(id, who)
  return result
}

export async function closeRoom(uid: string, id: unknown, deps = DEFAULT_DEPS): Promise<RoomResult<{ id: string }>> {
  const found = await load(deps, id, uid)
  if (!found) return notFound
  if (found.room.creator !== uid) return refused('only the creator closes the room')
  await deps.store.delete(path(found.id))
  revoker(found.id)
  return { ok: true, value: { id: found.id } }
}

/**
 * Delete rooms that have expired, up to `limit` at a time, closing any
 * connection still in them; returns how many went. Rooms are otherwise only
 * swept when their creator makes another, and a guest (adapters/local/
 * guest-identity.ts) may never come back.
 */
export async function sweepExpiredRooms(deps = DEFAULT_DEPS, limit = 500): Promise<number> {
  // Strictly before a millisecond from now: expired as isOpen counts it.
  const now = new Date(deps.now() + 1).toISOString()
  const expired = await deps.store.query(ROOM_COLLECTION, { lessThan: { field: 'expires', value: now }, orderBy: 'expires asc', limit })
  await Promise.all(expired.map((d) => deps.store.delete(d.path)))
  for (const d of expired) revoker(d.path.slice(ROOM_COLLECTION.length + 1))
  return expired.length
}
