/**
 * The options an endpoint deploys with (http.ts): public, its secrets, and a
 * longer request limit only where it asks for one.
 */
import { test, expect } from 'bun:test'
import { firebaseEndpoint } from './http'
import { ENDPOINTS } from '../../kernel'

type Deployed = { __endpoint: { timeoutSeconds?: unknown; secretEnvironmentVariables?: unknown[] } }
const deployed = (name: keyof typeof ENDPOINTS) => (firebaseEndpoint(ENDPOINTS[name]) as unknown as Deployed).__endpoint

test('gen may run five minutes: a proofread of a long post takes Gemini over a minute', () => {
  expect(deployed('gen').timeoutSeconds).toBe(300)
  expect(deployed('gen').secretEnvironmentVariables?.length).toBeGreaterThan(0)
})

test('other endpoints keep the default limit', () => {
  // firebase-functions marks an unset option with a ResetValue, not a number.
  expect(typeof deployed('doc').timeoutSeconds).not.toBe('number')
})
