/**
 * Game rooms, relay-only (D26): players' machines run the game, and the host
 * passes their messages to the room's other members.
 *
 * Transport-neutral. A host binds it to its own sockets
 * (`adapters/bun/rooms-socket.ts`); this module sees only text in and text out,
 * so the rules below are the same on every host and testable without one.
 *
 * ## The protocol (JSON text messages)
 *
 *   client → { type: 'join', room, token }    first message, within JOIN_TIMEOUT_MS
 *   host   → { type: 'joined', room, you, members }
 *          | { type: 'refused', reason }       then the host closes
 *   client → { type: 'send', data }
 *   host   → { type: 'message', from, data }   to every OTHER member
 *          | { type: 'presence', joined | left }
 *          | { type: 'limited', reason }       a message was dropped
 *
 * A browser cannot set headers on a WebSocket, so the token travels in the
 * join message rather than as a Bearer header.
 *
 * ## Permissions are checked once, at join (SOVEREIGN.md §D)
 *
 * `authorizeJoin` decides; after that a member's messages are not checked one
 * by one. The room is the boundary, so removing a member must close their
 * connection: `revoke`.
 *
 * ## Limits
 *
 * Every room caps message size and messages per second, so a member cannot
 * flood the others, and a host's bandwidth stays bounded. A room may ask for
 * lower limits than the host's, never higher.
 */

export interface RoomLimits {
  /** The largest message accepted, in bytes of its UTF-8 text. */
  messageBytes: number
  /** Sustained messages per second per member; a burst of up to one second's worth is allowed. */
  perSecond: number
}

/** The host's ceiling, and the limits a room gets when it asks for none. */
export const HOST_LIMITS: RoomLimits = { messageBytes: 4096, perSecond: 30 }

export const JOIN_TIMEOUT_MS = 5000

/** Close codes, in the range RFC 6455 leaves to applications. */
export const CLOSE = {
  refused: 4403,
  revoked: 4401,
  protocol: 4400,
  tooBig: 1009,
  joinTimeout: 4408,
} as const

export type JoinDecision = { ok: true; uid: string; limits?: Partial<RoomLimits> } | { ok: false; reason: string }

/** Who may join which room: the host's membership check. */
export type AuthorizeJoin = (room: string, token: string) => Promise<JoinDecision>

/** One socket, as the relay sees it. */
export interface Connection {
  send(text: string): void
  close(code: number, reason: string): void
}

/** What the transport tells the relay about one connection. */
export interface ConnectionHandle {
  receive(text: string): void
  closed(): void
}

export interface RelayOptions {
  authorizeJoin: AuthorizeJoin
  hostLimits?: RoomLimits
  /** Milliseconds; injectable so the rate limit is testable. */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export interface Relay {
  connect(conn: Connection): ConnectionHandle
  /** Close one member's connections to a room (they were removed from it). */
  revoke(room: string, uid: string): void
  /** Connected members of a room, for tests and diagnostics. */
  members(room: string): string[]
}

interface Member {
  conn: Connection
  uid: string
  room: string
  limits: RoomLimits
  tokens: number
  refilledAt: number
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

/** A room's limits: what it asked for, never above the host's. */
export function effectiveLimits(asked: Partial<RoomLimits> | undefined, host: RoomLimits): RoomLimits {
  const pick = (value: unknown, ceiling: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, ceiling) : ceiling
  return {
    messageBytes: pick(asked?.messageBytes, host.messageBytes),
    perSecond: pick(asked?.perSecond, host.perSecond),
  }
}

export function createRelay(options: RelayOptions): Relay {
  const hostLimits = options.hostLimits ?? HOST_LIMITS
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const rooms = new Map<string, Set<Member>>()

  const json = (conn: Connection, message: Record<string, unknown>) => conn.send(JSON.stringify(message))

  const broadcast = (member: Member, message: Record<string, unknown>) => {
    const text = JSON.stringify(message)
    for (const other of rooms.get(member.room) ?? []) if (other !== member) other.conn.send(text)
  }

  const uidsIn = (room: string) => [...new Set([...(rooms.get(room) ?? [])].map((m) => m.uid))]

  const leave = (member: Member) => {
    const set = rooms.get(member.room)
    if (!set?.delete(member)) return
    if (!set.size) rooms.delete(member.room)
    // Only a uid's last connection leaving is a departure.
    if (!uidsIn(member.room).includes(member.uid)) broadcast(member, { type: 'presence', left: member.uid })
  }

  // A token bucket: refills at perSecond, holds at most one second's worth.
  const allow = (member: Member) => {
    const t = now()
    member.tokens = Math.min(member.limits.perSecond, member.tokens + ((t - member.refilledAt) / 1000) * member.limits.perSecond)
    member.refilledAt = t
    if (member.tokens < 1) return false
    member.tokens -= 1
    return true
  }

  return {
    connect(conn) {
      let member: Member | null = null
      let joining = false
      let gone = false
      const timer = setTimer(() => {
        if (!member && !gone) conn.close(CLOSE.joinTimeout, 'join timed out')
      }, JOIN_TIMEOUT_MS)

      const join = async (room: string, token: string) => {
        joining = true
        let decision: JoinDecision
        try {
          decision = await options.authorizeJoin(room, token)
        } catch {
          decision = { ok: false, reason: 'could not check membership' }
        }
        if (gone) return
        if (!decision.ok) {
          json(conn, { type: 'refused', reason: decision.reason })
          conn.close(CLOSE.refused, decision.reason)
          return
        }
        clearTimer(timer)
        const limits = effectiveLimits(decision.limits, hostLimits)
        member = { conn, uid: decision.uid, room, limits, tokens: limits.perSecond, refilledAt: now() }
        const arriving = !uidsIn(room).includes(member.uid)
        if (!rooms.has(room)) rooms.set(room, new Set())
        rooms.get(room)?.add(member)
        json(conn, { type: 'joined', room, you: member.uid, members: uidsIn(room) })
        if (arriving) broadcast(member, { type: 'presence', joined: member.uid })
      }

      return {
        receive(text) {
          if (gone) return
          // Revoked: out of the room already, though the socket may not have closed yet.
          if (member && !rooms.get(member.room)?.has(member)) return
          if (member && bytes(text) > member.limits.messageBytes) {
            conn.close(CLOSE.tooBig, `messages are limited to ${member.limits.messageBytes} bytes`)
            return
          }
          // Before joining, nothing is relayed; the join itself is small.
          if (!member && bytes(text) > hostLimits.messageBytes) {
            conn.close(CLOSE.tooBig, 'join message too large')
            return
          }
          let message: { type?: unknown; room?: unknown; token?: unknown; data?: unknown }
          try {
            message = JSON.parse(text)
          } catch {
            conn.close(CLOSE.protocol, 'messages are JSON')
            return
          }
          if (!member) {
            if (joining || message?.type !== 'join' || typeof message.room !== 'string' || !message.room || typeof message.token !== 'string') {
              if (!joining) conn.close(CLOSE.protocol, 'the first message is a join')
              return
            }
            void join(message.room, message.token)
            return
          }
          if (message?.type !== 'send') {
            conn.close(CLOSE.protocol, `unknown message type`)
            return
          }
          if (!allow(member)) {
            json(conn, { type: 'limited', reason: `at most ${member.limits.perSecond} messages a second` })
            return
          }
          broadcast(member, { type: 'message', from: member.uid, data: message.data })
        },
        closed() {
          if (gone) return
          gone = true
          clearTimer(timer)
          if (member) leave(member)
          member = null
        },
      }
    },

    revoke(room, uid) {
      for (const member of [...(rooms.get(room) ?? [])]) {
        if (member.uid !== uid) continue
        // Out of the room now, not when the socket finishes closing.
        leave(member)
        member.conn.close(CLOSE.revoked, 'removed from the room')
      }
    },

    members: (room) => uidsIn(room),
  }
}
