/**
 * The HTTP port (http.ts) on one server: every endpoint, plus the site, the
 * way Firebase serves them, so a host needs no Cloud Functions and no Hosting.
 *
 * Two ways in, as in production:
 *
 * - **Functions**, at `/<project>/<region>/<name>/…`: the functions
 *   emulator's URL shape, which the client (TEST_MODE) and the integration
 *   suites already use. The handler sees the path AFTER the name, as a
 *   deployed function does.
 * - **Hosting**, everything else: `firebase.json`'s own `hosting` section,
 *   read at startup so the two cannot drift. A static file in `public` wins;
 *   otherwise the first matching rewrite's endpoint gets the FULL path.
 *   Hosting's header rules apply to every hosting response and REPLACE what
 *   a handler set (as on Firebase, where the `/blob` sandbox depends on it).
 *
 * Requests are parsed as Cloud Functions parses them (the functions
 * framework): JSON, text, url-encoded, and everything else raw, each keeping
 * `rawBody`, up to 32 MB; `trust proxy` on, no `x-powered-by`.
 *
 * Express on `node:http`, so handlers get the objects they get deployed. Under
 * Bun, `node:http` runs on Bun's own server.
 */
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { existsSync, readFileSync } from 'fs'
import type { ServerResponse } from 'http'
import { join, resolve } from 'path'
import type { Endpoint } from '../../kernel'
import type { Handler, HttpRequest } from '../../http'
import { log } from '../../log'

export interface HostingConfig {
  /** The static directory, relative to firebase.json. */
  public?: string
  rewrites?: Array<{ source?: string; regex?: string; function?: string | { functionId: string } }>
  headers?: Array<{ source?: string; regex?: string; headers: Array<{ key: string; value: string }> }>
}

export interface LocalAppOptions {
  endpoints: Record<string, Endpoint>
  /** firebase.json's `hosting`, and the directory its paths are relative to. */
  hosting?: { config: HostingConfig; root: string }
  /** Host-only routes, mounted ahead of everything else (and of Hosting's headers). */
  extraRoutes?: (app: express.Express) => void
}

const BODY_LIMIT = '32mb'

/** firebase.json's hosting section, from the repo root. */
export function readHosting(firebaseJson: string): { config: HostingConfig; root: string } {
  const config = JSON.parse(readFileSync(firebaseJson, 'utf8')).hosting as HostingConfig
  return { config, root: resolve(firebaseJson, '..') }
}

/**
 * A Hosting glob as a RegExp: `**` any path, `*` one segment, `?` one
 * character, `@(a|b)` one of the alternatives.
 */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (glob.startsWith('**', i)) {
      const after = glob[i + 2]
      if (out.endsWith('/') && after === undefined) {
        out = out.slice(0, -1) + '(?:/.*)?' // `/x/**`: x itself, or anything under it
        i += 1
      } else if (out.endsWith('/') && after === '/') {
        out += '(?:.*/)?' // `/**/`: zero or more directories
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '@' && glob[i + 1] === '(') {
      const close = glob.indexOf(')', i)
      out += `(?:${glob
        .slice(i + 2, close)
        .split('|')
        .map((alt) => alt.replace(/[.+^${}()[\]\\]/g, '\\$&'))
        .join('|')})`
      i = close
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

const matcher = (rule: { source?: string; regex?: string }) =>
  rule.regex ? new RegExp(rule.regex) : globToRegExp(rule.source ?? '')

/** Body parsing as the functions framework does it, keeping `rawBody`. */
function parseBodies(app: express.Express) {
  const verify = (req: unknown, _res: unknown, buf: Buffer) => {
    ;(req as HttpRequest).rawBody = buf
  }
  app.use(express.json({ limit: BODY_LIMIT, verify }))
  app.use(express.text({ limit: BODY_LIMIT, verify }))
  app.use(express.urlencoded({ limit: BODY_LIMIT, verify, extended: true }))
  app.use(express.raw({ limit: BODY_LIMIT, verify, type: '*/*' }))
  // A request with no body still has one, as on Cloud Functions.
  app.use((req, _res, next) => {
    const r = req as HttpRequest
    if (!r.rawBody) r.rawBody = Buffer.alloc(0)
    next()
  })
}

/** Run a handler; a throw or rejection is a 500, never a hung request. */
const run = (name: string, handler: Handler) => (req: Request, res: Response) => {
  const failed = (e: unknown) => {
    log.error(`${name}: unhandled`, e)
    if (!res.headersSent) res.status(500).send('Internal Server Error')
    else res.destroy()
  }
  try {
    Promise.resolve(handler(req as HttpRequest, res)).catch(failed)
  } catch (e) {
    failed(e)
  }
}

/** Set Hosting's headers as the response's headers are written, over the handler's. */
function hostingHeaders(res: ServerResponse, headers: Array<{ key: string; value: string }>) {
  if (!headers.length) return
  const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => ServerResponse
  res.writeHead = ((...args: unknown[]) => {
    for (const { key, value } of headers) res.setHeader(key, value)
    return writeHead(...args)
  }) as typeof res.writeHead
}

export function localApp({ endpoints, hosting, extraRoutes }: LocalAppOptions): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true)
  parseBodies(app)
  extraRoutes?.(app)

  // Functions: /<project>/<region>/<name>/rest → the handler sees /rest.
  const names = Object.keys(endpoints)
  const functionPath = new RegExp(`^/[^/]+/[^/]+/(${names.join('|')})(/[^?]*)?(\\?.*)?$`)
  app.use((req, res, next) => {
    const m = functionPath.exec(req.url)
    if (!m) return next()
    req.url = (m[2] || '/') + (m[3] ?? '')
    run(m[1], endpoints[m[1]].handler)(req, res)
  })

  if (!hosting) return app

  const { config, root } = hosting
  const headerRules = (config.headers ?? []).map((rule) => ({ match: matcher(rule), headers: rule.headers }))
  const rewrites = (config.rewrites ?? []).map((rule) => ({
    match: matcher(rule),
    name: typeof rule.function === 'string' ? rule.function : rule.function?.functionId,
  }))
  for (const { name } of rewrites) {
    if (name && !endpoints[name]) throw new Error(`firebase.json rewrites to an unknown endpoint: ${name}`)
  }

  app.use((req, res, next) => {
    // Later rules win for the same header, as on Hosting.
    const merged = new Map<string, { key: string; value: string }>()
    for (const rule of headerRules) {
      if (rule.match.test(req.path)) for (const h of rule.headers) merged.set(h.key.toLowerCase(), h)
    }
    hostingHeaders(res, [...merged.values()])
    next()
  })

  if (config.public) {
    const dir = join(root, config.public)
    if (existsSync(dir)) app.use(express.static(dir, { dotfiles: 'ignore', redirect: false }))
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    const rewrite = rewrites.find((r) => r.name && r.match.test(req.path))
    if (!rewrite?.name) return next()
    // What Hosting tells a rewritten function, overwriting anything the
    // caller sent: prefetch routes on the original URL, and social tags use
    // the site's host.
    req.headers['x-forwarded-url'] = req.originalUrl
    req.headers['x-forwarded-host'] = req.headers.host ?? ''
    run(rewrite.name, endpoints[rewrite.name].handler)(req, res)
  })
  return app
}
