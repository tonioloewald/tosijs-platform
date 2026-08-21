/**
 * Integration tests for the write path (`validate` / schema / `unique` /
 * provenance stamping) that require Firebase emulators.
 *
 * Run with: bun test src/collections/write-path.integration.test.ts
 *
 * Prerequisites (see access.integration.test.ts for the same setup):
 *   1. Build functions:   cd functions && npm run build
 *   2. Start emulators:   bun start-emulated   (from repo root)
 *   3. Seed emulators:    bun seed             (in another terminal)
 *
 * These exercise the parts of doc.ts that can't be unit-tested without Firestore:
 * the inline provenance merge, the `unique` constraint, schema/validate rejection,
 * and (end-to-end) both fixes from this session — module.validate initializing
 * `revisions` to 0 on create (not NaN) and incrementing it on a source change.
 *
 * They authenticate the same way the seed script does: mint an emulator ID token
 * for the seeded `owner@gmail.com` Google user, whose role grants every role.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { test, expect, describe, beforeAll } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

let PROJECT_ID = 'demo-project'
try {
  const firebaserc = JSON.parse(
    readFileSync(join(__dirname, '../../../.firebaserc'), 'utf-8')
  )
  PROJECT_ID = firebaserc.projects?.default || PROJECT_ID
} catch {
  // Use default
}

const FUNCTIONS_URL = `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`
const AUTH_URL = 'http://127.0.0.1:9099'

async function emulatorFunctionsRunning(): Promise<boolean> {
  try {
    await fetch(`${FUNCTIONS_URL}/hello`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    })
    return true
  } catch {
    return false
  }
}

// Mint an ID token for the seeded owner@gmail.com Google user, exactly as the
// seed script creates it (accounts:signInWithIdp with a fake OIDC token).
async function getOwnerIdToken(): Promise<string | undefined> {
  const fakeIdToken = JSON.stringify({
    sub: 'owner-uid',
    email: 'owner@gmail.com',
    name: 'Owner User',
    email_verified: true,
  })
  const postBody = `id_token=${encodeURIComponent(
    fakeIdToken
  )}&providerId=google.com`
  try {
    const res = await fetch(
      `${AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer owner',
        },
        body: JSON.stringify({
          postBody,
          requestUri: 'http://localhost',
          returnSecureToken: true,
          returnIdpCredential: true,
        }),
      }
    )
    if (!res.ok) return undefined
    const json = (await res.json()) as { idToken?: string }
    return json.idToken
  } catch {
    return undefined
  }
}

interface DocResponse {
  status: number
  text: string
  json: any
}

async function docRequest(
  method: string,
  path: string,
  token: string,
  data?: Record<string, unknown>
): Promise<DocResponse> {
  const headers: Record<string, string> = {
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
  const res = await fetch(url, init)
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, text, json }
}

describe('Write-path integration (validate / unique / provenance)', () => {
  let ready = false
  let token = ''
  // Unique-ish suffix without Date.now flakiness across parallel runs.
  const tag = `itest-${Math.floor(Math.random() * 1e9).toString(36)}`

  beforeAll(async () => {
    ready = await emulatorFunctionsRunning()
    if (!ready) {
      console.warn(
        '\n⚠️  Emulators not running. Start: bun start-emulated + bun seed\n'
      )
      return
    }
    token = (await getOwnerIdToken()) || ''
    if (!token) {
      console.warn('\n⚠️  Could not mint owner ID token from Auth emulator.\n')
      ready = false
    }
  })

  const skip = (): boolean => {
    if (!ready) {
      console.log('   [SKIPPED] Emulators not running')
      expect(true).toBe(true)
      return true
    }
    return false
  }

  describe('provenance stamping (doc.ts inline merge)', () => {
    test('create stamps _created/_modified; update preserves _created', async () => {
      if (skip()) return
      const path = `post/${tag}-prov`

      const created = await docRequest('POST', path, token, {
        title: `${tag} prov`,
        content: 'v1',
        path: `${tag}-prov`,
      })
      expect(created.status).toBe(200)

      const first = await docRequest('GET', path, token)
      expect(first.status).toBe(200)
      expect(typeof first.json._created).toBe('string')
      expect(typeof first.json._modified).toBe('string')
      expect(first.json._created).toBe(first.json._modified)

      // Ensure a later timestamp, then update.
      await new Promise((r) => setTimeout(r, 10))
      const patched = await docRequest('PATCH', path, token, { content: 'v2' })
      expect(patched.status).toBe(200)

      const second = await docRequest('GET', path, token)
      expect(second.json.content).toBe('v2')
      // _created is provenance: it must survive the update unchanged.
      expect(second.json._created).toBe(first.json._created)
      // _modified is refreshed on every write.
      expect(second.json._modified >= first.json._modified).toBe(true)

      await docRequest('DELETE', path, token) // best-effort cleanup
    })
  })

  describe('unique constraint (module.name)', () => {
    test('rejects a second document reusing a unique field value', async () => {
      if (skip()) return
      const name = `${tag}-mod`
      const body = {
        name,
        source: 'console.log(1)',
        version: '1.0.0',
        revisions: 0,
        tags: ['public'],
      }

      const a = await docRequest('POST', `module/${tag}-a`, token, body)
      expect(a.status).toBe(200)

      const b = await docRequest('POST', `module/${tag}-b`, token, {
        ...body,
        source: 'console.log(2)',
      })
      expect(b.status).toBe(400)
      expect(b.text.toLowerCase()).toContain('unique')

      await docRequest('DELETE', `module/${tag}-a`, token)
    })
  })

  describe('schema / validate rejection', () => {
    test('rejects a module with a non-semver version (schema leg)', async () => {
      if (skip()) return
      const res = await docRequest('POST', `module/${tag}-badver`, token, {
        name: `${tag}-badver`,
        source: 's',
        version: 'not-semver',
        revisions: 0,
        tags: [],
      })
      expect(res.status).toBe(400)
    })

    test('rejects a post missing required content', async () => {
      if (skip()) return
      const res = await docRequest('POST', `post/${tag}-nocontent`, token, {
        title: `${tag} no content`,
        path: `${tag}-nocontent`,
      })
      expect(res.status).toBe(400)
    })
  })

  describe('module.validate revisions (end-to-end fix verification)', () => {
    test('create initializes revisions to 0 (not NaN), increments on source change', async () => {
      if (skip()) return
      const path = `module/${tag}-rev`
      const name = `${tag}-rev`

      const created = await docRequest('POST', path, token, {
        name,
        source: 'v1',
        version: '1.0.0',
        revisions: 0,
        tags: ['public'],
      })
      expect(created.status).toBe(200)

      const afterCreate = await docRequest('GET', path, token)
      // Was NaN before the fix — NaN would serialize to null over JSON.
      expect(afterCreate.json.revisions).toBe(0)

      // PUT with a changed source must bump the revision count to 1.
      const updated = await docRequest('PUT', path, token, {
        name,
        source: 'v2-changed',
        version: '1.0.1',
        revisions: 0,
        tags: ['public'],
      })
      expect(updated.status).toBe(200)

      const afterUpdate = await docRequest('GET', path, token)
      expect(afterUpdate.json.revisions).toBe(1)

      await docRequest('DELETE', path, token)
    })
  })
})
