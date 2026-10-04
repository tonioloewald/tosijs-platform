/**
 * The one-click claim page (board #2489, D22): sign in with Google, click
 * Claim. Served at `/claim?page`.
 *
 * It replaces "curl the nonce, write it in the console, paste an ID token from
 * the browser console, curl again". The provisioner (or `scripts/claim.js`)
 * arms the claim with operator credentials — writing the proof, bound to the
 * operator's email — and opens this page for the last step, the one that has
 * to be a person: signing in.
 *
 * The page holds no authority. It shows nothing about the ceremony's state (a
 * refusal is generic, as on the wire), and the POST it makes is the same one
 * the manual ceremony makes. Self-contained: served by a Cloud Function, with
 * the Firebase auth SDK the only external script (as the consent page).
 */

const STYLE = `
:root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#666; --line:#ddd; }
@media (prefers-color-scheme: dark) { :root { --fg:#eee; --bg:#16181c; --muted:#9aa; --line:#333; } }
* { box-sizing:border-box }
body { margin:0; padding:2rem 1rem; font:16px/1.5 system-ui,sans-serif;
  color:var(--fg); background:var(--bg); display:flex; justify-content:center }
main { width:100%; max-width:34rem }
h1 { font-size:1.6rem; margin:0 0 1rem }
p { margin:0 0 1rem }
.muted { color:var(--muted) }
code { font:.9em ui-monospace,monospace; background:rgba(128,128,128,.15);
  padding:.1em .4em; border-radius:.25em }
button { font:inherit; padding:.7rem 1.4rem; border-radius:.5rem; cursor:pointer;
  border:1px solid #2563eb; background:#2563eb; color:#fff }
button[disabled] { opacity:.5; cursor:default }
#status { margin-top:1.5rem }
`

export function claimPage(): string {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claim this host</title><style>${STYLE}</style>
<main>
  <h1>Claim this host</h1>
  <p>Claiming makes your account this host's <strong>configurator</strong>: the
     one who may install libraries on it.</p>
  <p class="muted">It only works if the claim was armed for you just now, by
     someone with direct access to the host's datastore (the provisioner, or
     <code>bun scripts/claim.js</code>). Opening this page changes nothing.</p>
  <button id="claim" disabled>Sign in and claim</button>
  <p id="status" class="muted">Loading sign-in…</p>
</main>
<script type="module">
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'
import { getAuth, GoogleAuthProvider, signInWithPopup }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'

const status = document.getElementById('status')
const button = document.getElementById('claim')
const say = (text) => { status.textContent = text }

const config = await fetch('/authorize?action=config').then(r => r.json())
const auth = getAuth(initializeApp(config))
button.disabled = false
say('')

button.onclick = async () => {
  button.disabled = true
  try {
    say('Signing in…')
    const cred = await signInWithPopup(auth, new GoogleAuthProvider())
    const idToken = await cred.user.getIdToken()
    say('Claiming…')
    const res = await fetch('/claim', { method: 'POST', headers: { Authorization: 'Bearer ' + idToken } })
    if (res.ok) {
      say('Done. ' + (cred.user.email || 'Your account') + ' is now this host\\'s configurator. You can close this tab.')
      return
    }
    say('Not claimed. The claim is not armed for this account, or it expired. Arm it again from your terminal, then retry.')
    button.disabled = false
  } catch (e) {
    button.disabled = false
    say('Something went wrong: ' + (e && e.message || e))
  }
}
</script>`
}
