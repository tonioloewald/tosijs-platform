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
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { emulatorFetch } from './emulator-fetch.test'
import { acquireTarget, type IntegrationTarget } from './integration-target.test'

// The emulators or the in-process Bun host (integration-target.test.ts).
let target: IntegrationTarget | null = null
let FUNCTIONS_URL = ''

describe('Access Control Integration Tests', () => {
  let emulatorsRunning = false

  beforeAll(async () => {
    target = await acquireTarget()
    emulatorsRunning = target !== null
    if (target) FUNCTIONS_URL = target.functionsUrl
    if (!emulatorsRunning) {
      console.warn('\n⚠️  INTEGRATION_TARGET=emulators, but the emulators are not running.\n')
    }
  })
  afterAll(() => target?.release())

  describe('/doc endpoint access control', () => {
    test('returns proper response for public page access', async () => {
      if (!emulatorsRunning) {
        console.log('   [SKIPPED] Emulators not running')
        expect(true).toBe(true)
        return
      }

      const response = await emulatorFetch(`${FUNCTIONS_URL}/doc?p=page/path=default`, {
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

      const response = await emulatorFetch(`${FUNCTIONS_URL}/doc?p=role/owner-role`, {
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

      const response = await emulatorFetch(`${FUNCTIONS_URL}/doc`, {
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

      const response = await emulatorFetch(`${FUNCTIONS_URL}/doc?p=config/app`, {
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

      const response = await emulatorFetch(`${FUNCTIONS_URL}/docs?p=config`, {
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

      const response = await emulatorFetch(`${FUNCTIONS_URL}/docs?p=role`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })

      // Role collection should NOT be publicly listable, and the denial must be
      // OPAQUE: an anonymous caller gets 404, same as GET /doc?p=role/... . A 403
      // would confirm the collection exists and undo the opacity the doc endpoint
      // is careful about (see 'error message opacity for security' below).
      expect(response.status).toBe(404)
    })
  })

  describe('error message opacity for security', () => {
    test('public user gets opaque 404 for access denied (not 403)', async () => {
      if (!emulatorsRunning) {
        console.log('   [SKIPPED] Emulators not running')
        expect(true).toBe(true)
        return
      }

      const response = await emulatorFetch(`${FUNCTIONS_URL}/doc?p=role/owner-role`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })

      // Public users should see 404 "not found" not 403 "forbidden"
      // This is intentional to prevent information disclosure
      expect(response.status).toBe(404)
    })
  })
})
