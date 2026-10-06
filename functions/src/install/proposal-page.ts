/**
 * The install approval page (board #2490, D22). Served at `/install?request=<id>`.
 *
 * The one screen where a person lets a library define collections, access
 * rules and storage on their host, so it is written to be read:
 * - the CONFIRMATION CODE first: it must match the terminal that proposed
 *   this, which is what stops a link in a message being approved by reflex;
 * - EVERYTHING the manifest declares: each collection, each grant, each limit,
 *   each capability — described, never summarised away;
 * - after sign-in, a DRY RUN from the host: new install or upgrade, from which
 *   version, and any refusal, before anything is committed.
 *
 * It holds no authority: approving sends only the request id, and the host
 * installs the manifest IT stored, as the signed-in configurator.
 */
// embedJson, not JSON.stringify: a value inside a <script> must not be able to end it.
import { embedJson } from '../render/document'
import { summarize, type Proposal, type ProposalState } from './proposal'

const escape = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )

const STYLE = `
:root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#666; --line:#ddd;
  --warn-bg:#fff4e5; --warn-fg:#7a4100; }
@media (prefers-color-scheme: dark) { :root { --fg:#eee; --bg:#16181c; --muted:#9aa;
  --line:#333; --warn-bg:#3a2a12; --warn-fg:#ffd8a8; } }
* { box-sizing:border-box }
body { margin:0; padding:2rem 1rem; font:16px/1.5 system-ui,sans-serif;
  color:var(--fg); background:var(--bg); display:flex; justify-content:center }
main { width:100%; max-width:40rem }
h1 { font-size:1.1rem; font-weight:600; color:var(--muted); margin:0 0 .25rem }
.label { font-size:1.6rem; font-weight:700; margin:0 0 1rem; word-break:break-word }
.code { font:700 1.5rem ui-monospace,monospace; letter-spacing:.1em }
.warn { background:var(--warn-bg); color:var(--warn-fg); padding:1rem; border-radius:.5rem; margin:0 0 1.5rem }
section { border:1px solid var(--line); border-radius:.5rem; padding:1rem; margin:0 0 1rem }
section h2 { font-size:1rem; margin:0 0 .5rem; word-break:break-word }
.kind { color:var(--muted); font-weight:400 }
ul { margin:.25rem 0 0; padding-left:1.25rem }
code { font:.9em ui-monospace,monospace; background:rgba(128,128,128,.15); padding:.1em .4em; border-radius:.25em }
button { font:inherit; padding:.7rem 1.4rem; border-radius:.5rem; cursor:pointer;
  border:1px solid var(--line); background:transparent; color:var(--fg) }
button.primary { background:#2563eb; border-color:#2563eb; color:#fff }
button[disabled] { opacity:.5; cursor:default }
.row { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap }
#status { margin-top:1.5rem }
.muted { color:var(--muted) }
`

const head = (title: string) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style>`

const DONE: Record<string, string> = {
  missing: 'This install request does not exist.',
  expired: 'This install request has expired.',
  installed: 'This install request has already been approved.',
  denied: 'This install request was denied.',
  refused: 'This install request was refused by the host.',
  deciding: 'This install request is already being processed.',
}

export function proposalPage(proposal: Proposal | null, state: ProposalState | 'deciding', requestId: string): string {
  if (!proposal || state !== 'pending') {
    return `${head('Install request')}
<main><h1>Install</h1><p class="label">Nothing to approve</p>
<p>${DONE[state] ?? DONE.missing} Requests expire quickly — propose it again from your command line.</p></main>`
  }

  const s = summarize(proposal.manifest)
  const collections = s.collections.length
    ? s.collections
        .map(
          (c) => `<section><h2><code>${escape(c.name)}</code> <span class="kind">${escape(c.kind)}</span></h2>
<ul>${[
            ...(c.access.length ? c.access : ['no access rules: nobody can reach it']),
            ...c.notes,
          ]
            .map((line) => `<li>${escape(line)}</li>`)
            .join('')}</ul></section>`
        )
        .join('')
    : '<section><p class="muted">This manifest declares no collections.</p></section>'
  const capabilities = s.capabilities.length
    ? `<section><h2>Capabilities it asks for</h2><ul>${s.capabilities
        .map((c) => `<li><code>${escape(c.name)}</code> — ${escape(c.kind)}</li>`)
        .join('')}</ul></section>`
    : ''

  return `${head(`Install ${s.name}`)}
<main>
  <h1>A command line is asking to install a library on this host</h1>
  <p class="label">${escape(s.name)} <span class="kind">${escape(s.version)}</span></p>
  <p class="warn"><strong>Check this code matches your terminal:</strong>
     <span class="code">${escape(proposal.code)}</span><br>
     If you did not just propose this install yourself, do not approve it.</p>
  ${s.description ? `<p>${escape(s.description)}</p>` : ''}
  ${collections}
  ${capabilities}
  <p class="muted">Request expires ${escape(proposal.expiresAt)}. Installing makes these collections reachable under
     exactly these rules. It deletes nothing.</p>
  <div class="row">
    <button class="primary" id="review" disabled>Sign in to review</button>
    <button class="primary" id="install" hidden>Install</button>
    <button id="deny">Deny</button>
  </div>
  <div id="status" class="muted">Loading sign-in…</div>
</main>
<script type="module">
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'
import { getAuth, GoogleAuthProvider, signInWithPopup }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'

const REQUEST = ${embedJson(requestId)}
const status = document.getElementById('status')
const review = document.getElementById('review')
const install = document.getElementById('install')
const deny = document.getElementById('deny')
// Text only, always: nothing from the host or the manifest is set as HTML.
const say = (...lines) => { status.replaceChildren(...lines.map((l) => Object.assign(document.createElement('p'), { textContent: l }))) }

const config = await fetch('/authorize?action=config').then(r => r.json())
const auth = getAuth(initializeApp(config))
review.disabled = false
say('')

let idToken = null
const call = (action, data, authed) => fetch('/install?action=' + action, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(authed ? { Authorization: 'Bearer ' + idToken } : {}) },
  body: JSON.stringify(data),
}).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }))

const describe = (b) => {
  if (b.status === 'needs-approval') return ['This upgrade adds capabilities: ' + (b.added || []).map((c) => c.name).join(', ') + '. Installing approves them.']
  if (b.status === 'unchanged') return ['This exact version is already installed. Installing changes nothing.']
  if (b.from) return ['This UPGRADES ' + b.name + ' from ' + b.from + ' to ' + b.version + '.']
  return ['This is a NEW install of ' + b.name + ' ' + b.version + '.']
}

review.onclick = async () => {
  review.disabled = true
  try {
    say('Signing in…')
    const cred = await signInWithPopup(auth, new GoogleAuthProvider())
    idToken = await cred.user.getIdToken()
    say('Checking what this would do…')
    const r = await call('preview', { requestId: REQUEST }, true)
    if (r.status === 403) { say('This account is not the host\\'s configurator, so it cannot install.'); review.disabled = false; return }
    if (!r.ok) {
      const problems = (r.body.problems || []).map((p) => '• ' + p)
      say('The host would REFUSE this manifest:', ...problems, r.body.message || '')
      return
    }
    const lines = describe(r.body)
    if ((r.body.unenforced || []).length) lines.push('Not enforced by this host yet: ' + r.body.unenforced.join(', ') + '.')
    for (const sup of (r.body.superseded || [])) lines.push(sup.capability + ': ' + sup.use)
    say(...lines)
    review.hidden = true
    install.hidden = false
  } catch (e) {
    review.disabled = false
    say('Something went wrong: ' + (e && e.message || e))
  }
}

install.onclick = async () => {
  install.disabled = deny.disabled = true
  say('Installing…')
  const r = await call('approve', { requestId: REQUEST, approve: true }, true)
  if (r.ok) say('Installed: ' + r.body.name + ' ' + r.body.version + ' (' + r.body.status + '). You can close this tab and return to your terminal.')
  else say('Not installed: ' + (r.body.message || r.status), ...((r.body.problems || []).map((p) => '• ' + p)))
}

deny.onclick = async () => {
  review.disabled = install.disabled = deny.disabled = true
  await call('approve', { requestId: REQUEST, approve: false }, false)
  say('Denied. Nothing was installed.')
}
</script>`
}
