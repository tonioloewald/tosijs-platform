/**
 * Privilege LIFECYCLE — grant, exercise, change, revoke, re-attempt.
 *
 * Asked for 2026-09-11: "does our test suite include coverage for a user with
 * sufficient privileges changing access to a collection, exercising the
 * privileges, changing them again, having their own privileges revoked and then
 * trying to change them?"
 *
 * It did not. Every access test in this repo was **static**: a literal
 * CollectionMap plus a literal UserRoles in, a decision out. That exercises
 * `getMethodAccess` — a pure function — and never exercises `getUserRoles`,
 * which is what actually decides *who you are*. Before this file, `getUserRoles`
 * appeared in the test suite exactly once, in a comment.
 *
 * Static tests cannot see a state machine. This file is the state machine: every
 * assertion happens AFTER a mutation, through the real endpoint, with a real
 * token.
 *
 * ## What "changing access" means today
 *
 * Collection access config (`COLLECTIONS`) is compiled TypeScript, so nobody can
 * change it at runtime — that is D6/D2 territory and not yet data. The
 * runtime-mutable half of authorization is the **`role` collection**: who holds
 * which roles. That is what these tests drive.
 *
 * REQUIRES EMULATORS. Skip-guarded, and the skip prints loudly — a skipped test
 * is not a passing one.
 */
import { describe, test, expect, beforeAll } from 'bun:test'
import { emulatorFetch } from './emulator-fetch.test'

const PROJECT_ID = 'liquid-force-425209-g2'
const FUNCTIONS_URL = `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`
const AUTH_URL = 'http://127.0.0.1:9099'

let emulatorsRunning = false
let ownerToken = ''
let subjectToken = ''
// The uid the platform sees is the emulator's generated localId, NOT the `sub`
// we mint with — an assumption worth pinning, since role documents key on it.
let subjectUid = ''

/** Mint an emulator ID token for an arbitrary identity. */
async function idTokenFor(
  sub: string,
  email: string
): Promise<{ token: string; uid: string }> {
  const postBody = `id_token=${encodeURIComponent(
    JSON.stringify({ sub, email, email_verified: true })
  )}&providerId=google.com`
  const res = await emulatorFetch(
    `${AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake-api-key`,
    {
      method: 'POST',
      // 'Bearer owner' is the emulator's ADMIN credential authorising the call.
      // The identity being minted comes from postBody — varying this header with
      // the subject makes the emulator reject the request with 401.
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({
        postBody,
        requestUri: 'http://localhost',
        returnIdpCredential: true,
        returnSecureToken: true,
      }),
    }
  )
  if (!res.ok) return { token: '', uid: '' }
  const body = (await res.json()) as { idToken?: string; localId?: string }
  return { token: body.idToken ?? '', uid: body.localId ?? '' }
}

const doc = async (
  token: string,
  method: string,
  path: string,
  data?: Record<string, unknown>
) => {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
  let url = `${FUNCTIONS_URL}/doc`
  const init: RequestInit = { method, headers }
  if (method === 'GET' || method === 'DELETE') {
    url += `?p=${encodeURIComponent(path)}`
  } else {
    init.body = JSON.stringify({ p: path, data })
  }
  const res = await emulatorFetch(url, init)
  const text = await res.text()
  return { status: res.status, text }
}

const SUBJECT_EMAIL = 'lifecycle-subject@example.com'
const SUBJECT_SUB = 'lifecycle-subject'
const SUBJECT_ROLE = 'role/lifecycle-subject-role'

/**
 * Write the subject's role document as the owner — creating it if absent.
 *
 * THROWS on failure rather than returning a status the caller might ignore. A
 * setup step that silently fails turns every assertion after it into a vacuous
 * pass, which is the exact failure mode this file exists to close.
 */
const setSubjectRoles = async (
  roles: string[],
  contacts = true,
  userIds?: string[]
) => {
  const body = {
    name: 'lifecycle-subject-role',
    roles,
    contacts: contacts ? [{ type: 'email', value: SUBJECT_EMAIL }] : [],
    userIds: userIds ?? [],
  }
  let r = await doc(ownerToken, 'PUT', SUBJECT_ROLE, body)
  if (r.status !== 200) {
    // PUT requires an existing document; POST creates one.
    r = await doc(ownerToken, 'POST', SUBJECT_ROLE, body)
  }
  if (r.status !== 200) {
    throw new Error(
      `setup failed: owner could not write ${SUBJECT_ROLE} — ${r.status} ${r.text.slice(0, 120)}`
    )
  }
  return r
}

/** What does the server currently believe about the subject? */
const whoAmI = async () => {
  const res = await emulatorFetch(`${FUNCTIONS_URL}/user`, {
    headers: { Authorization: `Bearer ${subjectToken}` },
  })
  if (!res.ok) return { roles: [] as string[], status: res.status }
  const body = (await res.json()) as { roles?: string[] }
  return { roles: body.roles ?? [], status: res.status }
}

beforeAll(async () => {
  try {
    const res = await fetch(`${FUNCTIONS_URL}/hello`, {
      signal: AbortSignal.timeout(3000),
    })
    emulatorsRunning = res.ok || res.status < 500
  } catch {
    emulatorsRunning = false
  }
  if (!emulatorsRunning) return
  ownerToken = (await idTokenFor('owner', 'owner@gmail.com')).token
  const subject = await idTokenFor(SUBJECT_SUB, SUBJECT_EMAIL)
  subjectToken = subject.token
  subjectUid = subject.uid
})

const guard = (): boolean => {
  if (!emulatorsRunning || !ownerToken || !subjectToken) {
    console.log('   [SKIPPED] Emulators not running — privilege lifecycle NOT verified')
    return true
  }
  return false
}

describe('privilege lifecycle: grant → exercise → change → revoke → re-attempt', () => {
  test('0. baseline — an unknown principal holds no roles', async () => {
    if (guard()) return expect(true).toBe(true)
    await doc(ownerToken, 'DELETE', SUBJECT_ROLE)
    const me = await whoAmI()
    expect(me.roles).toEqual([])
  })

  test('1. owner GRANTS the subject a role, and it takes effect on the next request', async () => {
    if (guard()) return expect(true).toBe(true)
    await setSubjectRoles(['author'])
    const me = await whoAmI()
    expect(me.roles).toContain('author')
  })

  test('2. the subject can EXERCISE the granted privilege', async () => {
    if (guard()) return expect(true).toBe(true)
    // `author` holds list: ALL on post, so an author sees unpublished posts.
    const res = await emulatorFetch(`${FUNCTIONS_URL}/docs?p=post&c=5`, {
      headers: { Authorization: `Bearer ${subjectToken}` },
    })
    expect(res.status).toBe(200)
  })

  test('3. owner CHANGES the roles, and the change takes effect immediately', async () => {
    if (guard()) return expect(true).toBe(true)
    await setSubjectRoles(['editor'])
    const me = await whoAmI()
    expect(me.roles).toContain('editor')
    expect(me.roles).not.toContain('author') // the OLD grant must be gone
  })

  test('4. REVOKE by emptying roles — the subject holds nothing', async () => {
    if (guard()) return expect(true).toBe(true)
    await setSubjectRoles([])
    const me = await whoAmI()
    expect(me.roles).toEqual([])
  })

  test('5. a revoked subject CANNOT grant themselves anything back', async () => {
    if (guard()) return expect(true).toBe(true)
    // The monotonicity property (D4): no write may increase the writer's own
    // authority. A principal with no roles must not be able to edit `role`.
    const attempt = await doc(subjectToken, 'PUT', SUBJECT_ROLE, {
      name: 'lifecycle-subject-role',
      roles: ['owner', 'developer', 'admin'],
      contacts: [{ type: 'email', value: SUBJECT_EMAIL }],
      userIds: [],
    })
    expect([401, 403, 404]).toContain(attempt.status)

    const me = await whoAmI()
    expect(me.roles).toEqual([]) // and it did not take effect
  })

  test('6. a revoked subject cannot exercise the privilege they used to have', async () => {
    if (guard()) return expect(true).toBe(true)
    // They may still LIST posts (public can), but must not see unpublished ones.
    const res = await emulatorFetch(`${FUNCTIONS_URL}/docs?p=post&c=50`, {
      headers: { Authorization: `Bearer ${subjectToken}` },
    })
    if (res.status !== 200) {
      expect([401, 403, 404]).toContain(res.status)
      return
    }
    const rows = (await res.json()) as Array<Record<string, unknown>>
    const unpublished = rows.filter(
      (r) => 'date' in r && !String(r.date ?? '').trim()
    )
    expect(unpublished.length).toBe(0)
  })
})

describe('REVOCATION BY uid ALONE — the read path re-grants it', () => {
  // getUserRoles does a WRITE during a read: if the uid lookup misses, it falls
  // back to matching `contacts` by email and then APPENDS the uid back into
  // userIds for "future fast lookups". So removing a uid is not revocation —
  // the next request re-adds it. Only a stateful test can see this.
  test('7. granting by email populates userIds automatically (the fast-path writeback)', async () => {
    if (guard()) return expect(true).toBe(true)
    const w = await setSubjectRoles(['author'], true, []) // email only, NO uid
    if (w.status !== 200) return

    const me = await whoAmI()
    expect(me.roles).toContain('author') // matched via contacts

    // the read path should have written the uid back
    const after = await doc(ownerToken, 'GET', SUBJECT_ROLE)
    if (after.status === 200) {
      const role = JSON.parse(after.text) as { userIds?: string[] }
      expect(role.userIds ?? []).toContain(subjectUid)
    }
  })

  test('8. removing the uid does NOT revoke — the email fallback re-grants', async () => {
    if (guard()) return expect(true).toBe(true)
    // Revoke the way an operator plausibly would: drop them from userIds.
    await setSubjectRoles(['author'], true, [])

    const me = await whoAmI()
    // DOCUMENTED HAZARD: still author, because contacts still matches.
    expect(me.roles).toContain('author')
  })

  test('9. revocation requires removing the CONTACT, not just the uid', async () => {
    if (guard()) return expect(true).toBe(true)
    const w = await setSubjectRoles([], false, []) // no roles, no contacts
    if (w.status !== 200) return
    const me = await whoAmI()
    expect(me.roles).toEqual([])
  })

  test('10. cleanup', async () => {
    if (guard()) return expect(true).toBe(true)
    await doc(ownerToken, 'DELETE', SUBJECT_ROLE)
    expect(true).toBe(true)
  })
})

describe('D4 escalation: can a privileged user raise their OWN authority?', () => {
  // The question's sharp end. `role.ts` currently grants ROLES.admin
  // `write: ALL` on the role collection, and getUserRoles reads that collection
  // to decide who you are — so an admin can edit the input to their own
  // authorization. D4 calls this the circularity; monotonicity ("no write may
  // increase the writer's own authority") is the fix and needs isWriteAllowed.
  //
  // These tests assert the CURRENT behaviour, including where it is wrong, so
  // the suite flips the day role.ts moves to owner-only.
  const ADMIN_ROLE = 'role/lifecycle-admin-role'
  const ADMIN_EMAIL = 'lifecycle-admin@example.com'
  let adminToken = ''

  test('11. setup: owner grants a second subject `admin`', async () => {
    if (guard()) return expect(true).toBe(true)
    const a = await idTokenFor('lifecycle-admin', ADMIN_EMAIL)
    adminToken = a.token
    await doc(ownerToken, 'DELETE', ADMIN_ROLE)
    const body = {
      name: 'lifecycle-admin-role',
      roles: ['admin'],
      contacts: [{ type: 'email', value: ADMIN_EMAIL }],
      userIds: [],
    }
    let r = await doc(ownerToken, 'PUT', ADMIN_ROLE, body)
    if (r.status !== 200) r = await doc(ownerToken, 'POST', ADMIN_ROLE, body)
    expect(r.status).toBe(200)
  })

  test('12. FIXED (D4): an admin can no longer write the role collection', async () => {
    if (guard()) return expect(true).toBe(true)
    // Was a tripwire asserting the escalation worked; `role.ts` is now
    // owner-only and it flipped, exactly as designed. The denial is OPAQUE —
    // an admin is not privileged for `role`, so it reads as 404 rather than 403.
    const attempt = await doc(adminToken, 'PUT', ADMIN_ROLE, {
      name: 'lifecycle-admin-role',
      roles: ['admin', 'developer'], // self-elevation attempt
      contacts: [{ type: 'email', value: ADMIN_EMAIL }],
      userIds: [],
    })
    expect([401, 403, 404]).toContain(attempt.status)
  })

  test('13. and the self-grant did NOT take effect', async () => {
    if (guard()) return expect(true).toBe(true)
    const res = await emulatorFetch(`${FUNCTIONS_URL}/user`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
    const me = (await res.json()) as { roles?: string[] }
    // The chain is severed at step one: no developer, so no /esm write, so no
    // arbitrary JS. This is the property D4 exists to protect.
    expect(me.roles ?? []).not.toContain('developer')
    expect(me.roles ?? []).toContain('admin') // unchanged, not escalated
  })

  test('13b. an admin can no longer READ the role collection either', async () => {
    if (guard()) return expect(true).toBe(true)
    // Deliberate consequence of the one-line fix: the entry granted read/write/
    // list together, so admin lost all three. Acceptable because production has
    // no admin and `role` holds contact PII; revisit if a role-manager UI ever
    // needs admin visibility (it would be a separate read-only entry).
    const r = await doc(adminToken, 'GET', ADMIN_ROLE)
    expect([401, 403, 404]).toContain(r.status)
  })

  test('14. cleanup', async () => {
    if (guard()) return expect(true).toBe(true)
    await doc(ownerToken, 'DELETE', ADMIN_ROLE)
    expect(true).toBe(true)
  })
})
