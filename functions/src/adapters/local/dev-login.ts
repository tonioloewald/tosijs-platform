/**
 * `/__dev/login`: sign the browser in as anyone, on a LOCAL host only.
 *
 * Lists the host's role documents; choosing one (or typing a uid and email)
 * stores a dev identity token (identity.ts) in the site's localStorage under
 * `dev-identity-token`, which the client (src/firebase.ts) sends in place of a
 * Firebase ID token in TEST_MODE. `?signout` clears it.
 *
 * A backdoor by design, so it exists only where dev identities do: serve.ts
 * mounts it only alongside them, and refuses them off loopback.
 */
import type { Express, Request, Response } from 'express'
import { dataStore } from '../../datastore'
import { devToken } from './identity'

export const DEV_LOGIN_PATH = '/__dev/login'
export const DEV_TOKEN_KEY = 'dev-identity-token'

const escape = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const tokenFor = (uid: string, email?: string, name?: string) =>
  devToken({ sub: uid, ...(email ? { email, email_verified: true } : {}), ...(name ? { name } : {}) })

/** Store `token` (or clear it), then go to the site. */
const apply = (token: string | null) => `<script>
  ${token ? `localStorage.setItem(${JSON.stringify(DEV_TOKEN_KEY)}, ${JSON.stringify(token)})` : `localStorage.removeItem(${JSON.stringify(DEV_TOKEN_KEY)})`}
  location.href = '/'
</script>`

async function page(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store')
  res.set('X-Dev-Login', '1') // how the client tells this page from the site's catch-all
  res.set('Content-Type', 'text/html; charset=utf-8')
  if ('signout' in req.query) return void res.send(apply(null))
  const uid = typeof req.query.uid === 'string' ? req.query.uid.trim() : ''
  if (uid) {
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : ''
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : ''
    return void res.send(apply(tokenFor(uid, email, name)))
  }

  const roles = await dataStore.query('role', { orderBy: '~', limit: 200 })
  const rows = roles
    .map(({ data }) => {
      const uids = (data.userIds as string[] | undefined) ?? []
      const email = ((data.contacts as Array<{ type?: string; value?: string }> | undefined) ?? []).find(
        (c) => c.type === 'email'
      )?.value
      const as = uids[0] ?? ''
      const href = `${DEV_LOGIN_PATH}?${new URLSearchParams({
        uid: as || `email:${email ?? 'unknown'}`,
        ...(email ? { email } : {}),
        name: String(data.name ?? ''),
      })}`
      return `<tr><td><a href="${escape(href)}">${escape(data.name ?? as)}</a></td>
        <td>${escape(((data.roles as string[] | undefined) ?? []).join(', '))}</td>
        <td>${escape(as || '(by email)')}</td><td>${escape(email ?? '')}</td></tr>`
    })
    .join('\n')
  res.send(`<!doctype html><meta charset="utf-8"><title>Dev sign-in</title>
<style>body{font:15px system-ui;margin:2rem;max-width:60rem}td,th{padding:.3rem .6rem;text-align:left}
input{font:inherit}</style>
<h1>Dev sign-in</h1>
<p>Local host only: these identities are unsigned. Pick a role document to act as its user.</p>
<table><tr><th>Role</th><th>Roles</th><th>uid</th><th>email</th></tr>
${rows || '<tr><td colspan="4">No role documents on this host.</td></tr>'}
</table>
<h2>Someone else</h2>
<form method="get" action="${DEV_LOGIN_PATH}">
<label>uid <input name="uid" required></label>
<label>email <input name="email" type="email"></label>
<label>name <input name="name"></label>
<button>Sign in</button></form>
<p><a href="${DEV_LOGIN_PATH}?signout">Sign out</a> · <a href="/">Site</a></p>`)
}

/** Mount the page on `app`. Only for a host with dev identities. */
export function mountDevLogin(app: Express): void {
  app.get(DEV_LOGIN_PATH, (req, res) => {
    page(req, res).catch((e) => res.status(500).send(escape(e)))
  })
}
