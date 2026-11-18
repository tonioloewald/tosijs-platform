/**
 * `/room`: make a game room, join one, see it, leave or close it (D26). The
 * rules are in rooms/rooms.ts; this only maps HTTP onto them.
 *
 *   POST   { maxMembers?, limits? }   make a room → the room, with its code
 *   PUT    { id, code }               join it
 *   GET    ?id=                       a member sees the room
 *   DELETE ?id=&uid=                  remove a member (the creator), or leave (your own uid)
 *   DELETE ?id=                       close it (the creator)
 *
 * Every caller must be signed in. The connection itself is a WebSocket at
 * `/rooms` on hosts that hold sockets (adapters/bun/rooms-socket.ts).
 */
import type { Handler } from './http'
import { optionsResponse, getUser } from './utilities'
import { fail, noStore } from './errors'
import { createRoom, joinRoom, getRoom, removeMember, closeRoom, type RoomResult } from './rooms/rooms'

const send = <T>(res: Parameters<Handler>[1], result: RoomResult<T>, status = 200) => {
  if (result.ok) res.status(status).json(result.value)
  else fail(res, result.status, result.error, result.message)
}

const body = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

export const handleRoom: Handler = async (req, res) => {
  noStore(res)
  if (optionsResponse(req, res, ['GET', 'POST', 'PUT', 'DELETE'])) return
  const user = await getUser(req)
  if (!user) {
    fail(res, 401, 'unauthenticated', 'sign in to use rooms')
    return
  }
  const { uid } = user
  const { id, uid: who } = req.query
  switch (req.method) {
    case 'POST':
      send(res, await createRoom(uid, body(req.body)), 201)
      return
    case 'PUT':
      send(res, await joinRoom(uid, body(req.body)))
      return
    case 'GET':
      send(res, await getRoom(uid, id))
      return
    case 'DELETE':
      send(res, who === undefined ? await closeRoom(uid, id) : await removeMember(uid, id, who))
      return
  }
}
