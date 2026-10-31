/**
 * The test process cannot reach a real Firebase project (test-setup.ts). If
 * this fails, the preload is not running, and any test that calls through to
 * an adapter talks to gcloud's default project instead of the emulators.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'

test('tests run against the emulators, under a demo- project, with dummy credentials', () => {
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBe('127.0.0.1:8080')
  expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBe('127.0.0.1:9099')
  expect(process.env.FIREBASE_STORAGE_EMULATOR_HOST).toBe('127.0.0.1:9199')
  expect(process.env.GCLOUD_PROJECT).toStartWith('demo-')
  const credentials = JSON.parse(
    readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '', 'utf8')
  )
  expect(credentials.quota_project_id).toBe('demo-test')
  expect(credentials.client_id).toEndWith('.invalid')
})
