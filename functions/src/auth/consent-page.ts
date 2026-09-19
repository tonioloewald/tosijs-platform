/**
 * The consent page (B2, #6).
 *
 * The one screen where a human grants an agent real authority, so it is written
 * to be read rather than clicked past:
 *
 *   - the **label** is shown first and largest. It is the agent context and it
 *     is the provenance every write this token makes will carry.
 *   - the **caveats are listed in full** — roles, methods, collections. The
 *     token minted at exchange is exactly this and nothing else, because the
 *     caveats were pinned when the CLI started the flow.
 *   - a **`poll`-mode request carries an explicit warning**. Loopback returns
 *     the result to the machine that started the flow, so a phished approval
 *     goes nowhere; polling has no such binding, and the honest thing is to say
 *     so on the screen rather than in a design document.
 *
 * Self-contained by necessity: it is served by a Cloud Function under a strict
 * CSP, with the Firebase auth SDK the only external script.
 */

import type { AuthorizeRequest } from './authorize'

const escape = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] as string
  )

const list = (values: unknown): string => {
  const items = Array.isArray(values) ? values : []
  if (!items.length) return '<em>none</em>'
  return items.map((v) => `<code>${escape(v)}</code>`).join(' ')
}

const STYLE = `
:root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#666;
  --line:#ddd; --warn-bg:#fff4e5; --warn-fg:#7a4100; }
@media (prefers-color-scheme: dark) { :root { --fg:#eee; --bg:#16181c;
  --muted:#9aa; --line:#333; --warn-bg:#3a2a12; --warn-fg:#ffd8a8; } }
* { box-sizing:border-box }
body { margin:0; padding:2rem 1rem; font:16px/1.5 system-ui,sans-serif;
  color:var(--fg); background:var(--bg); display:flex; justify-content:center }
main { width:100%; max-width:34rem }
h1 { font-size:1.1rem; font-weight:600; color:var(--muted); margin:0 0 .25rem }
.label { font-size:1.6rem; font-weight:700; margin:0 0 1.5rem; word-break:break-word }
dl { display:grid; grid-template-columns:auto 1fr; gap:.5rem 1rem; margin:0 0 1.5rem;
  padding:1rem; border:1px solid var(--line); border-radius:.5rem }
dt { color:var(--muted) } dd { margin:0 }
code { font:.9em ui-monospace,monospace; background:rgba(128,128,128,.15);
  padding:.1em .4em; border-radius:.25em }
.warn { background:var(--warn-bg); color:var(--warn-fg); padding:1rem;
  border-radius:.5rem; margin:0 0 1.5rem }
button { font:inherit; padding:.7rem 1.4rem; border-radius:.5rem; cursor:pointer;
  border:1px solid var(--line); background:transparent; color:var(--fg) }
button.primary { background:#2563eb; border-color:#2563eb; color:#fff }
button[disabled] { opacity:.5; cursor:default }
.row { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap }
#status { margin-top:1.5rem; color:var(--muted) }
`

export function consentPage(
  record: AuthorizeRequest | null,
  requestId: string
): string {
  if (!record || record.status !== 'pending') {
    const why = !record
      ? 'This authorization request does not exist.'
      : `This request has already been ${escape(record.status)}.`
    return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorization request</title><style>${STYLE}</style>
<main><h1>Authorization</h1><p class="label">Nothing to approve</p>
<p>${why} Requests expire quickly — start a new one from your command line.</p></main>`
  }

  const caveats = record.caveats as Record<string, unknown>
  const expires = escape(record.expiresAt)

  const warning =
    record.mode === 'poll'
      ? `<p class="warn"><strong>Check you started this.</strong> This request
         was made in polling mode, which means the result is collected by
         whoever is waiting for it — not necessarily by this device. If you did
         not start this from a terminal yourself, do not approve it.</p>`
      : ''

  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${escape(record.label)}</title><style>${STYLE}</style>
<main>
  <h1>A command line is asking for access as you</h1>
  <p class="label">${escape(record.label)}</p>
  ${warning}
  <dl>
    <dt>Roles</dt><dd>${list(caveats.roles)}</dd>
    <dt>Methods</dt><dd>${
      caveats.methods
        ? list(caveats.methods)
        : '<code>GET</code> <code>LIST</code> <code>POST</code> <code>PUT</code> <code>PATCH</code>'
    }</dd>
    <dt>Collections</dt><dd>${
      caveats.collections ? list(caveats.collections) : '<em>all</em>'
    }</dd>
    <dt>Request expires</dt><dd>${expires}</dd>
  </dl>
  <p>The token will carry <strong>exactly</strong> this, and never more than you
     hold yourself. Revoking your own access revokes it too.</p>
  <div class="row">
    <button class="primary" id="approve" disabled>Sign in and approve</button>
    <button id="deny">Deny</button>
  </div>
  <p id="status">Loading sign-in…</p>
</main>
<script type="module">
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'
import { getAuth, GoogleAuthProvider, signInWithPopup }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'

const REQUEST = ${JSON.stringify(requestId)}
const status = document.getElementById('status')
const approve = document.getElementById('approve')
const deny = document.getElementById('deny')

const config = await fetch('/authorize?action=config').then(r => r.json())
const auth = getAuth(initializeApp(config))
approve.disabled = false
status.textContent = ''

const post = (action, body) => fetch('/authorize?action=' + action, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...body.headers },
  body: JSON.stringify(body.data),
}).then(r => r.json())

approve.onclick = async () => {
  approve.disabled = deny.disabled = true
  try {
    status.textContent = 'Signing in…'
    const cred = await signInWithPopup(auth, new GoogleAuthProvider())
    const idToken = await cred.user.getIdToken()
    status.textContent = 'Approving…'
    const result = await post('approve', {
      headers: { Authorization: 'Bearer ' + idToken },
      data: { requestId: REQUEST, approve: true },
    })
    if (result.status !== 'approved') {
      status.textContent = 'Refused: ' + (result.reason || 'unknown')
      return
    }
    if (result.redirect) {
      status.textContent = 'Approved — returning to your terminal…'
      location.href = result.redirect
    } else {
      status.textContent = 'Approved. You can close this tab and return to your terminal.'
    }
  } catch (e) {
    approve.disabled = deny.disabled = false
    status.textContent = 'Something went wrong: ' + (e && e.message || e)
  }
}

deny.onclick = async () => {
  approve.disabled = deny.disabled = true
  await post('approve', { headers: {}, data: { requestId: REQUEST, approve: false } })
  status.textContent = 'Denied. Nothing was granted.'
}
</script>`
}
