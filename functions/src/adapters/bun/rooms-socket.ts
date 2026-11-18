/**
 * Game rooms on the Bun host (D26): WebSockets at `/rooms`, relayed by
 * `rooms/relay.ts`, membership read by `rooms/membership.ts`.
 *
 * `ws` here is Bun's built-in implementation, which is why it is in no
 * package.json. This file runs only on the Bun host; Cloud Functions cannot
 * hold a socket open, and the Firebase backend is Realtime Database.
 */
import type { Server } from 'http'
import { WebSocketServer } from 'ws'
import { createRelay, HOST_LIMITS, type Relay, type RelayOptions } from '../../rooms/relay'
import { roomMembership } from '../../rooms/membership'
import { setRoomRevoker } from '../../rooms/rooms'

export const ROOMS_PATH = '/rooms'

export interface RoomSockets {
  relay: Relay
  close(): void
}

export function mountRoomSockets(server: Server, options: Partial<RelayOptions> = {}): RoomSockets {
  const relay = createRelay({ authorizeJoin: roomMembership, ...options })
  // Removing a member through /room closes their connection here.
  const previousRevoker = setRoomRevoker((room, uid) => relay.revoke(room, uid))
  // An oversized frame is refused while it arrives, not after it is buffered.
  const wss = new WebSocketServer({ noServer: true, maxPayload: (options.hostLimits ?? HOST_LIMITS).messageBytes })

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://host').pathname !== ROOMS_PATH) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const handle = relay.connect({
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
      })
      ws.on('message', (data, isBinary) => {
        // Text frames only: the protocol is JSON.
        if (isBinary) ws.close(4400, 'messages are JSON text')
        else handle.receive(String(data))
      })
      ws.on('close', () => handle.closed())
      ws.on('error', () => handle.closed())
    })
  })

  return {
    relay,
    close: () => {
      for (const ws of wss.clients) ws.terminate()
      wss.close()
      setRoomRevoker(previousRevoker)
    },
  }
}
