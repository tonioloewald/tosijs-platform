/**
 * `bun run serve:local`: the whole platform in one Bun process, with no
 * Firebase and no emulators (SOVEREIGN-PLAN.md Phase 2).
 *
 *   bun functions/src/adapters/bun/serve.ts [--data .local] [--port 5001]
 *       [--host 127.0.0.1] [--no-dev-identities]
 *
 * Ports installed: SQLite (`<data>/host.db`) for documents and the render
 * cache, a directory (`<data>/files`) for /blob and /stored, the console for
 * logs, and dev identities (adapters/local/identity.ts).
 *
 * Dev identities are unsigned, so they are only ever installed on a loopback
 * address; on any other the server refuses to start with them. Without them
 * no token verifies and every caller is anonymous (identity.ts fails closed).
 *
 * Port 5001 and the functions route keep the client's TEST_MODE URLs working.
 */
import { createServer, type Server } from 'http'
import { mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { ENDPOINTS } from '../../kernel'
import { setDataStoreProvider } from '../../datastore'
import { setFilesProvider } from '../../files'
import { identity, setIdentityProvider } from '../../identity'
import { sqliteDataStore } from '../sqlite/datastore'
import { directoryFiles } from '../local/files'
import { devIdentities } from '../local/identity'
import { localApp, readHosting } from '../local/http'

export interface LocalHostOptions {
  /** Where host.db and files/ live. */
  dataDir: string
  port?: number
  host?: string
  devIdentities?: boolean
  /** firebase.json, for the site's static files, rewrites and headers; omit for endpoints only. */
  firebaseJson?: string
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export interface LocalHost {
  server: Server
  url: string
  close(): Promise<void>
}

export async function serveLocal(options: LocalHostOptions): Promise<LocalHost> {
  const host = options.host ?? '127.0.0.1'
  const useDevIdentities = options.devIdentities ?? true
  if (useDevIdentities && !LOOPBACK.has(host)) {
    throw new Error(`dev identities are unsigned: refusing to serve them on ${host} (use a loopback address)`)
  }

  mkdirSync(options.dataDir, { recursive: true })
  const data = sqliteDataStore(join(options.dataDir, 'host.db'))
  setDataStoreProvider(data)
  setFilesProvider(directoryFiles(join(options.dataDir, 'files')))
  const previousIdentity = identity()
  if (useDevIdentities) setIdentityProvider(devIdentities())

  const app = localApp({
    endpoints: ENDPOINTS,
    hosting: options.firebaseJson ? readHosting(options.firebaseJson) : undefined,
  })
  const server = createServer(app)
  const uninstall = () => {
    setDataStoreProvider(null)
    setFilesProvider(null)
    setIdentityProvider(previousIdentity)
    data.close()
  }
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail)
      server.listen(options.port ?? 5001, host, () => done())
    })
  } catch (e) {
    uninstall() // a port in use leaves nothing installed or open
    throw e
  }
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return {
    server,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    close: () =>
      new Promise<void>((done) => {
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
  const repo = resolve(import.meta.dir, '../../../..')
  serveLocal({
    dataDir: resolve(flag(args, '--data') ?? join(repo, '.local')),
    port: Number(flag(args, '--port') ?? 5001),
    host: flag(args, '--host') ?? '127.0.0.1',
    devIdentities: !args.includes('--no-dev-identities'),
    firebaseJson: join(repo, 'firebase.json'),
  }).then(
    ({ url }) => console.log(`tosijs-platform (local) at ${url}`),
    (e) => {
      console.error(String(e instanceof Error ? e.message : e))
      process.exit(1)
    }
  )
}
