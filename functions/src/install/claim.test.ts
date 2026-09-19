/**
 * The claim ceremony (A3, #5).
 *
 * This decides who gets `configurator` on a fresh host — i.e. who may install
 * libraries, which means who may create collections, define their schemas and
 * decide who can write them. It is the most consequential decision in the
 * install system, so the refusals matter more than the grant.
 *
 * Run: cd functions && bun test src/install/claim.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import {
  decideClaim,
  rotatedState,
  hasBeenClaimed,
  NONCE_TTL_MS,
  CLAIM_PATH,
  type ClaimState,
} from './claim'
import { COLLECTIONS } from '../collections'

const NOW = Date.parse('2026-09-19T12:00:00.000Z')
const fresh = (over: Partial<ClaimState> = {}): ClaimState => ({
  nonce: 'abc123',
  issuedAt: new Date(NOW - 1000).toISOString(),
  ...over,
})

describe('the happy path', () => {
  test('a matching proof from an authenticated caller grants', () => {
    const d = decideClaim({
      state: fresh({ proof: 'abc123' }),
      principal: 'uid-1',
      now: NOW,
    })
    expect(d).toEqual({ status: 'granted', principal: 'uid-1', rotate: true })
  })
})

describe('refusals', () => {
  test('an unauthenticated claim is refused — a grant must be attributable', () => {
    expect(
      decideClaim({ state: fresh({ proof: 'abc123' }), principal: null, now: NOW })
    ).toEqual({ status: 'refused', reason: 'no-principal' })
  })

  test('no nonce published', () => {
    expect(decideClaim({ state: null, principal: 'uid', now: NOW })).toEqual({
      status: 'refused',
      reason: 'no-nonce',
    })
  })

  test('no proof written — the whole point of the ceremony', () => {
    // Knowing the nonce is not the claim. WRITING it, where only the datastore
    // holder can write, is the claim.
    expect(
      decideClaim({ state: fresh(), principal: 'uid', now: NOW })
    ).toMatchObject({ reason: 'no-proof' })
  })

  test('a wrong proof is refused', () => {
    expect(
      decideClaim({
        state: fresh({ proof: 'not-the-nonce' }),
        principal: 'uid',
        now: NOW,
      })
    ).toMatchObject({ reason: 'mismatch' })
  })

  test('an expired nonce is refused even with a correct proof', () => {
    expect(
      decideClaim({
        state: fresh({
          proof: 'abc123',
          issuedAt: new Date(NOW - NONCE_TTL_MS - 1).toISOString(),
        }),
        principal: 'uid',
        now: NOW,
      })
    ).toMatchObject({ reason: 'expired' })
  })

  test('an UNDATED nonce is treated as expired, not as fresh', () => {
    // Failing open here would make a nonce with no issuedAt usable forever.
    expect(
      decideClaim({
        state: { nonce: 'abc123', proof: 'abc123' },
        principal: 'uid',
        now: NOW,
      })
    ).toMatchObject({ reason: 'expired' })
  })

  test('an unparseable issuedAt is treated as expired', () => {
    expect(
      decideClaim({
        state: fresh({ proof: 'abc123', issuedAt: 'not-a-date' }),
        principal: 'uid',
        now: NOW,
      })
    ).toMatchObject({ reason: 'expired' })
  })

  test('an empty proof does not match an empty nonce', () => {
    // Guards the degenerate state where both are blank and `===` would grant.
    expect(
      decideClaim({
        state: { nonce: '', proof: '', issuedAt: new Date(NOW).toISOString() },
        principal: 'uid',
        now: NOW,
      })
    ).toMatchObject({ reason: 'no-nonce' })
  })
})

describe('rotation — what stops the ceremony becoming a back door', () => {
  test('a grant always demands rotation', () => {
    const d = decideClaim({
      state: fresh({ proof: 'abc123' }),
      principal: 'uid',
      now: NOW,
    })
    expect(d).toMatchObject({ rotate: true })
  })

  test('the rotated state carries a NEW nonce and NO proof', () => {
    const next = rotatedState(
      fresh({ proof: 'abc123' }),
      'xyz789',
      'uid-1',
      new Date(NOW).toISOString()
    )
    expect(next.nonce).toBe('xyz789')
    expect(next.proof).toBeUndefined()
    expect(next.claimedBy).toBe('uid-1')
  })

  test('replaying the old proof against the rotated state is refused', () => {
    // The attack rotation prevents: without it the proof stays in the datastore
    // and the NEXT authenticated caller claims for free.
    const next = rotatedState(
      fresh({ proof: 'abc123' }),
      'xyz789',
      'uid-1',
      new Date(NOW).toISOString()
    )
    expect(
      decideClaim({ state: next, principal: 'attacker', now: NOW })
    ).toMatchObject({ reason: 'no-proof' })

    // And the OLD nonce no longer matches the new one.
    expect(
      decideClaim({
        state: { ...next, proof: 'abc123' },
        principal: 'attacker',
        now: NOW,
      })
    ).toMatchObject({ reason: 'mismatch' })
  })

  test('re-claiming is possible with a FRESH write — break-glass survives', () => {
    // Recovery matters: a configurator who loses their account must be able to
    // re-establish control by proving datastore access again.
    const next = rotatedState(
      fresh({ proof: 'abc123' }),
      'xyz789',
      'uid-1',
      new Date(NOW).toISOString()
    )
    expect(
      decideClaim({
        state: { ...next, proof: 'xyz789' },
        principal: 'uid-2',
        now: NOW,
      })
    ).toMatchObject({ status: 'granted', principal: 'uid-2' })
  })

  test('a re-claim is visible as one — it is not a silent bootstrap', () => {
    const claimed = rotatedState(
      fresh({ proof: 'abc123' }),
      'xyz789',
      'uid-1',
      new Date(NOW).toISOString()
    )
    expect(hasBeenClaimed(null)).toBe(false)
    expect(hasBeenClaimed(fresh())).toBe(false)
    expect(hasBeenClaimed(claimed)).toBe(true)
  })
})

describe('the claim document is unreachable through /doc', () => {
  test('its collection is NOT registered, so the endpoint denies it to everyone', () => {
    // Deny-by-default is the whole protection: an unregistered collection is
    // invisible to /doc for every principal, owner included. If someone ever
    // adds a config for it, the ceremony becomes writable over HTTP and the
    // "only the datastore holder can write this" premise collapses.
    const [collection] = CLAIM_PATH.split('/')
    expect(collection).toBe('system:claim')
    expect(COLLECTIONS[collection]).toBeUndefined()
  })

  test('it is namespaced, so no manifest can declare it either', () => {
    // `system:` is not a namespace any manifest may claim — refuseDeclaration
    // only permits a manifest its OWN namespace.
    expect(CLAIM_PATH).toContain(':')
  })
})
