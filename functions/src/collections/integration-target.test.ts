/**
 * What the integration suites run against: the Firebase emulators, or the Bun
 * host (adapters/bun/serve.ts) started in this process — so they no longer
 * need Java to run at all (SOVEREIGN-PLAN.md Phase 2).
 *
 * `INTEGRATION_TARGET=emulators|local` chooses. Unset, the emulators are used
 * when their functions answer, and otherwise the local host — so these suites
 * EXERCISE the code on every `bun test`, instead of passing vacuously when no
 * emulator is up.
 *
 * A suite needs three things from a target, and gets them the same way from
 * both:
 * - `functionsUrl`: endpoints at `<functionsUrl>/<name>`;
 * - `idTokenFor(sub, email)`: a bearer token for a fresh identity, and the uid
 *   the platform will see (the emulator assigns its own; a dev identity's is
 *   its `sub`);
 * - `grantRoles(docId, uid, roles)`: a role document written straight into the
 *   datastore, bypassing /doc (the emulator's admin credential, or the
 *   in-process store).
 *
 * Lives in a `*.test.ts` file so the deployed build excludes it.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { emulatorFetch, grantEmulatorRoles } from './emulator-fetch.test'

export interface IntegrationTarget {
  kind: 'emulators' | 'local'
  functionsUrl: string
  idTokenFor(sub: string, email: string): Promise<{ token: string; uid: string }>
  grantRoles(docId: string, uid: string, roles: string[]): Promise<boolean>
  /** Call once per acquire, in afterAll: the local host stops when its last suite releases it. */
  release(): Promise<void>
}

const PROJECT_ID = (() => {
  try {
    const rc = JSON.parse(readFileSync(join(__dirname, '../../../.firebaserc'), 'utf-8'))
    return (rc.projects?.default as string) || 'demo-project'
  } catch {
    return 'demo-project'
  }
})()
const EMULATOR_FUNCTIONS = `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`
const AUTH_URL = 'http://127.0.0.1:9099'

async function emulatorsUp(): Promise<boolean> {
  try {
    await fetch(`${EMULATOR_FUNCTIONS}/hello`, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

const emulators: IntegrationTarget = {
  kind: 'emulators',
  functionsUrl: EMULATOR_FUNCTIONS,
  async idTokenFor(sub, email) {
    const postBody = `id_token=${encodeURIComponent(
      JSON.stringify({ sub, email, email_verified: true })
    )}&providerId=google.com`
    const res = await emulatorFetch(
      `${AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake-api-key`,
      {
        method: 'POST',
        // 'Bearer owner' is the emulator's ADMIN credential authorising the call;
        // the identity minted comes from postBody.
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
        body: JSON.stringify({ postBody, requestUri: 'http://localhost', returnIdpCredential: true, returnSecureToken: true }),
      }
    )
    if (!res.ok) return { token: '', uid: '' }
    const body = (await res.json()) as { idToken?: string; localId?: string }
    return { token: body.idToken ?? '', uid: body.localId ?? '' }
  },
  grantRoles: (docId, uid, roles) => grantEmulatorRoles(PROJECT_ID, docId, uid, roles),
  release: async () => undefined,
}

// One local host per process, shared by every suite that asks for one.
let local: { target: IntegrationTarget; users: number; stop(): Promise<void> } | null = null
let starting: Promise<NonNullable<typeof local>> | null = null

async function startLocal() {
  const { serveLocal } = await import('../adapters/bun/serve')
  const { dataStore } = await import('../datastore')
  const { devToken } = await import('../adapters/local/identity')
  const dir = mkdtempSync(join(tmpdir(), 'integration-local-'))
  const host = await serveLocal({
    dataDir: dir,
    port: 0,
    firebaseJson: join(__dirname, '../../../firebase.json'),
  })
  const target: IntegrationTarget = {
    kind: 'local',
    functionsUrl: `${host.url}/${PROJECT_ID}/us-central1`,
    idTokenFor: async (sub, email) => ({ token: devToken({ sub, email, email_verified: true }), uid: sub }),
    async grantRoles(docId, uid, roles) {
      // As grantEmulatorRoles writes it: `_created` too, which role lookup orders by.
      await dataStore.set(`role/${docId}`, {
        name: docId,
        roles,
        userIds: [uid],
        contacts: [],
        _created: new Date().toJSON(),
      })
      return true
    },
    release: async () => {
      if (local && --local.users === 0) {
        const stopping = local
        local = null
        starting = null
        await stopping.stop()
      }
    },
  }
  return {
    target,
    users: 0,
    stop: async () => {
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * The target for this run, or null when the one asked for is not available
 * (only `INTEGRATION_TARGET=emulators` with none running). Release it in afterAll.
 */
export async function acquireTarget(): Promise<IntegrationTarget | null> {
  const wanted = process.env.INTEGRATION_TARGET
  if (wanted !== 'local' && (await emulatorsUp())) return emulators
  if (wanted === 'emulators') return null
  starting ??= startLocal()
  local = await starting
  local.users++
  return local.target
}

describe('the integration target', () => {
  test('a local target serves endpoints and honours the roles it grants', async () => {
    if (process.env.INTEGRATION_TARGET === 'emulators') return
    const previous = process.env.INTEGRATION_TARGET
    process.env.INTEGRATION_TARGET = 'local'
    const target = await acquireTarget()
    process.env.INTEGRATION_TARGET = previous
    try {
      expect(target?.kind).toBe('local')
      if (!target) return
      expect((await fetch(`${target.functionsUrl}/hello`)).status).toBe(200)
      const { token, uid } = await target.idTokenFor('target-check', 'target-check@example.invalid')
      const roles = async () =>
        (await (await fetch(`${target.functionsUrl}/user`, { headers: { Authorization: `Bearer ${token}` } })).json())
          .roles
      expect(await roles()).toEqual([])
      expect(await target.grantRoles('target-check', uid, ['author'])).toBe(true)
      expect(await roles()).toEqual(['author'])
    } finally {
      await target?.release()
    }
  })
})
