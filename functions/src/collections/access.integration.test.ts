/**
 * Integration tests for access control that require Firebase emulators.
 *
 * Run with: bun test src/collections/access.integration.test.ts
 *
 * Prerequisites:
 * - Build functions first: npm run build (in functions/)
 * - Firebase emulators must be running: bun start-emulated
 * - Emulators should be seeded: bun seed
 *
 * NOTE: If you make changes to the functions, you must restart the emulators
 * for changes to take effect. The emulators run the compiled code in lib/.
 *
 * These tests verify that the access control system works correctly
 * when integrated with the actual Cloud Functions endpoints.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { test, expect, describe, beforeAll } from 'bun:test'

// Read project ID from .firebaserc
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

const EMULATOR_HOST = 'http://127.0.0.1:5001'
const FUNCTIONS_URL = `${EMULATOR_HOST}/${PROJECT_ID}/us-central1`

// Check if emulators are running by trying to hit a known function
async function checkEmulatorFunctionsRunning(): Promise<boolean> {
  try {
    // Try the hello endpoint which should always exist
    await fetch(`${FUNCTIONS_URL}/hello`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    })
    // If we get any response (even an error), the functions emulator is running
    return true
  } catch (e: any) {
    // Connection refused or timeout means emulator isn't running
    if (e.code === 'ECONNREFUSED' || e.name === 'TimeoutError') {
      return false
    }
    // Other errors might mean it's running but the endpoint doesn't exist
    return false
  }
}

describe('Access Control Integration Tests', () => {
  let emulatorsRunning = false

  beforeAll(async () => {
    emulatorsRunning = await checkEmulatorFunctionsRunning()
    if (!emulatorsRunning) {
      console.warn(
        '\n⚠️  Firebase function emulators are not running or not responding.'
      )
      console.warn('   Start emulators with: bun start-emulated')
      console.warn('   Then seed data with: bun seed')
      console.warn(`   Expected URL: ${FUNCTIONS_URL}/hello\n`)
    }
  })

  describe('/doc endpoint access control', () => {
    test('returns proper response for public page access', async () => {
      if (!emulatorsRunning) {
        console.log('   [SKIPPED] Emulators not running')
        expect(true).toBe(true)
        return
      }

      const response = await fetch(`${FUNCTIONS_URL}/doc?p=page/path=default`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })

      // Should succeed (200) or return not found (404) if page doesn't exist
      // Should NOT return 403 forbidden since pages are public readable
      expect([200, 404]).toContain(response.status)
      if (response.status === 403) {
        throw new Error('Public page access was incorrectly denied')
      }
    })

    test('denies public access to protected role collection', async () => {
      if (!emulatorsRunning) {
        console.log('   [SKIPPED] Emulators not running')
        expect(true).toBe(true)
        return
      }

      const response = await fetch(`${FUNCTIONS_URL}/doc?p=role/owner-role`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })

      // Public users should see 404 "not found" (opaque error)
      // This prevents information disclosure about protected resources
      expect(response.status).toBe(404)
    })

    test('denies unauthenticated write to posts', async () => {
      if (!emulatorsRunning) {
        console.log('   [SKIPPED] Emulators not running')
        expect(true).toBe(true)
        return
      }

      const response = await fetch(`${FUNCTIONS_URL}/doc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p: 'post/test-post-' + Date.now(),
          data: { title: 'Test', content: 'Hello', path: 'test' },
        }),
      })

      // Should be denied - either 403 or opaque 404
      expect([403, 404]).toContain(response.status)
    })

    test('denies unauthenticated delete', async () => {
      if (!emulatorsRunning) {
        console.log('   [SKIPPED] Emulators not running')
        expect(true).toBe(true)
        return
      }

      const response = await fetch(`${FUNCTIONS_URL}/doc?p=config/app`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      })

      // Should be denied - either 403 or opaque 404
      expect([403, 404]).toContain(response.status)
    })
  })

  describe('/docs endpoint access control', () => {
    test('allows public listing of config collection', async () => {
      if (!emulatorsRunning) {
        console.log('   [SKIPPED] Emulators not running')
        expect(true).toBe(true)
        return
      }

      const response = await fetch(`${FUNCTIONS_URL}/docs?p=config`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })

      // Config collection should be publicly listable
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(Array.isArray(data)).toBe(true)
    })

    test('denies public listing of role collection', async () => {
      if (!emulatorsRunning) {
        console.log('   [SKIPPED] Emulators not running')
        expect(true).toBe(true)
        return
      }

      const response = await fetch(`${FUNCTIONS_URL}/docs?p=role`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })

      // Role collection should NOT be publicly listable
      expect(response.status).toBe(403)
    })
  })

  describe('error message opacity for security', () => {
    test('public user gets opaque 404 for access denied (not 403)', async () => {
      if (!emulatorsRunning) {
        console.log('   [SKIPPED] Emulators not running')
        expect(true).toBe(true)
        return
      }

      const response = await fetch(`${FUNCTIONS_URL}/doc?p=role/owner-role`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })

      // Public users should see 404 "not found" not 403 "forbidden"
      // This is intentional to prevent information disclosure
      expect(response.status).toBe(404)
    })
  })
})

describe('Emulator status', () => {
  test('checks emulator availability', async () => {
    const running = await checkEmulatorFunctionsRunning()
    if (running) {
      console.log(
        `\n✓ Firebase function emulators are running at ${FUNCTIONS_URL}`
      )
    } else {
      console.log(
        `\n✗ Firebase function emulators not detected at ${FUNCTIONS_URL}`
      )
      console.log('  Integration tests were skipped.')
      console.log('  To run integration tests:')
      console.log('    1. bun start-emulated')
      console.log('    2. bun seed (in another terminal)')
      console.log('    3. bun test src/collections/access.integration.test.ts')
    }
    // Always passes - informational only
    expect(true).toBe(true)
  })
})
