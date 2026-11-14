/**
 * Who may join a room (D26): the caller's token names them, and the room's
 * document lists its members.
 *
 * A room is the document `room/<id>`:
 *
 *   { members: ['uid', …], limits?: { messageBytes?, perSecond? } }
 *
 * The member list is written through `/doc`, under the `room` collection's
 * rules, never by a socket. Joining only reads it. An anonymous caller, a
 * room that does not exist and a caller not on the list are all refused.
 */
import { identity } from '../identity'
import { dataStore } from '../datastore'
import type { AuthorizeJoin, RoomLimits } from './relay'

export const ROOM_COLLECTION = 'room'

/** A room id is one path segment: no `/`, nothing a path could be built from. */
export const ROOM_ID = /^[A-Za-z0-9_-]{1,128}$/

export const roomMembership: AuthorizeJoin = async (room, token) => {
  if (!ROOM_ID.test(room)) return { ok: false, reason: 'not a room id' }
  let uid: string
  try {
    uid = (await identity().verifyIdToken(token)).uid
  } catch {
    return { ok: false, reason: 'sign in to join a room' }
  }
  const doc = await dataStore.get(`${ROOM_COLLECTION}/${room}`)
  // The same answer for "no such room" and "not a member": a room's existence is not public.
  const members = doc.exists && Array.isArray(doc.data.members) ? doc.data.members : []
  if (!members.includes(uid)) return { ok: false, reason: 'not a member of this room' }
  const limits = doc.data.limits
  return { ok: true, uid, limits: limits && typeof limits === 'object' ? (limits as Partial<RoomLimits>) : undefined }
}
