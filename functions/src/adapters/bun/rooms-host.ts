/**
 * The rooms host: game rooms and nothing else, on one Bun process (D26, v1).
 * Rooms v1 does not use Firebase; this is what runs on the preview box.
 *
 *   POST /guest   { name? }   a guest token (adapters/local/guest-identity.ts)
 *        /room                make, join, see, leave, close rooms (room-endpoint.ts)
 *        /rooms               the room WebSocket (rooms-socket.ts)
 *   GET  /health
 *
 * Unlike `serve:local` it binds no other endpoint, no site and no files, so a
 * guest can reach nothing but rooms. Documents are SQLite (`<data>/host.db`).
 * The guest secret is `<data>/guest-secret`, made on first start; deleting it
 * signs every guest out.
 *
 * It runs behind a proxy on the same machine (Caddy), so it listens on
 * loopback and takes the client address from X-Forwarded-For, as on Firebase.
 *
 *   bun functions/src/adapters/bun/rooms-host.ts --data /var/lib/tosijs-rooms [--port 5101]
 *
 * `bun run build:rooms-host` compiles it to one executable with Bun inside.
 */
import express from 'express'
import { createServer, type Server } from 'http'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { join, resolve } from 'path'
import { setDataStoreProvider } from '../../datastore'
import { identity, setIdentityProvider } from '../../identity'
import { sqliteDataStore } from '../sqlite/datastore'
import { parseBodies, run } from '../local/http'
import type { HttpRequest } from '../../http'
import { guestIdentities } from '../local/guest-identity'
import { mountRoomSockets, type RoomSockets } from './rooms-socket'
import { handleRoom } from '../../room-endpoint'
import { sweepExpiredRooms } from '../../rooms/rooms'
import { optionsResponse, type RateLimitConfig } from '../../utilities'
import { fail, noStore } from '../../errors'
import { log } from '../../log'

export interface RoomsHostOptions {
  /** Where host.db and guest-secret live. */
  dataDir: string
  port?: number
  host?: string
  /**
   * Requests per client address for /guest (default utilities.ts's 100 a
   * minute). The count is the one /room uses too: per address, not per path.
   */
  guestRateLimit?: RateLimitConfig
  /** How often expired rooms are swept (default hourly). */
  sweepEveryMs?: number
}

export interface RoomsHost {
  server: Server
  url: string
  rooms: RoomSockets
  close(): Promise<void>
}

/** The host's guest secret, made (32 random bytes, owner-only) if absent. */
function guestSecret(dataDir: string): Buffer {
  const file = join(dataDir, 'guest-secret')
  if (!existsSync(file)) writeFileSync(file, randomBytes(32), { mode: 0o600 })
  chmodSync(file, 0o600)
  return readFileSync(file)
}

export async function serveRooms(options: RoomsHostOptions): Promise<RoomsHost> {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })
  const guests = guestIdentities(guestSecret(options.dataDir))
  const data = sqliteDataStore(join(options.dataDir, 'host.db'))
  setDataStoreProvider(data)
  const previousIdentity = identity()
  setIdentityProvider(guests.provider)

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  parseBodies(app)
  app.all('/guest', (req, res) => {
    noStore(res)
    if (optionsResponse(req as HttpRequest, res, ['POST'], options.guestRateLimit)) return
    const name = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).name : undefined
    const guest = guests.issue(name)
    if (guest instanceof Error) return fail(res, 400, 'bad-request', guest.message)
    res.status(201).json(guest)
  })
  app.all('/room', run('room', handleRoom))
  app.get('/health', (_req, res) => {
    noStore(res)
    res.json({ ok: true })
  })
  app.use((_req, res) => fail(res, 404, 'not-found', 'not found'))

  const server = createServer(app)
  const rooms = mountRoomSockets(server)
  const sweep = () =>
    sweepExpiredRooms().then(
      (n) => n && log.info(`rooms: swept ${n} expired`),
      (e) => log.error('rooms: sweep failed', e)
    )
  const sweeper = setInterval(sweep, options.sweepEveryMs ?? 3600_000)
  const uninstall = () => {
    clearInterval(sweeper)
    setDataStoreProvider(null)
    setIdentityProvider(previousIdentity)
    data.close()
  }
  const host = options.host ?? '127.0.0.1'
  try {
    await new Promise<void>((done, failed) => {
      server.once('error', failed)
      server.listen(options.port ?? 5101, host, () => done())
    })
  } catch (e) {
    rooms.close()
    uninstall()
    throw e
  }
  void sweep()
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return {
    server,
    rooms,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    close: () =>
      new Promise<void>((done) => {
        rooms.close()
        server.close(() => {
          uninstall()
          done()
        })
        server.closeAllConnections()
      }),
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const dataDir = flag(args, '--data')
  if (!dataDir) {
    console.error('usage: rooms-host --data <dir> [--port 5101] [--host 127.0.0.1]')
    process.exit(2)
  }
  serveRooms({
    dataDir: resolve(dataDir),
    port: Number(flag(args, '--port') ?? 5101),
    host: flag(args, '--host') ?? '127.0.0.1',
  }).then(
    (h) => {
      console.log(`tosijs-platform rooms at ${h.url}`)
      const stop = () => {
        void h.close().then(() => process.exit(0))
      }
      // As Node's emitter: Bun's own types give `process.on` only Bun's events.
      const signals = process as unknown as NodeJS.EventEmitter
      signals.on('SIGTERM', stop)
      signals.on('SIGINT', stop)
    },
    (e) => {
      console.error(String(e instanceof Error ? e.message : e))
      process.exit(1)
    }
  )
}
