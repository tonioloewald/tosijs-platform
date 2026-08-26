// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { test, expect, describe } from 'bun:test'

import { poke, TOY_SOUNDS } from './toy-capability'

/**
 * The Marvelous Toy — the capability-gate fixture (UNIVERSAL-ENDPOINT.md §2.6).
 * These pin the three behaviour tiers so the future VM-injected toy can be held
 * to the same contract (and so §9.1/§9.2 have a concrete target).
 */
describe('toy capability — tiered by the caller’s rights', () => {
  test('unauthenticated caller is DENIED (can’t use it)', () => {
    expect(poke(null)).toEqual({ status: 'denied' })
  })

  test('authenticated but non-admin is INERT (doesn’t do anything)', () => {
    expect(poke([])).toEqual({ status: 'inert' })
    expect(poke(['author', 'editor'])).toEqual({ status: 'inert' })
  })

  test('admin makes it ACTIVE — it makes a noise', () => {
    const out = poke(['admin'])
    expect(out.status).toBe('active')
    if (out.status === 'active') {
      expect(TOY_SOUNDS).toContain(out.sound as (typeof TOY_SOUNDS)[number])
    }
  })

  test('the noise is deterministic in n (no ambient randomness)', () => {
    expect(poke(['admin'], 0)).toEqual({ status: 'active', sound: 'zip' })
    expect(poke(['admin'], 1)).toEqual({ status: 'active', sound: 'bop' })
    expect(poke(['admin'], 2)).toEqual({ status: 'active', sound: 'whirr' })
    // wraps
    expect(poke(['admin'], 3)).toEqual({ status: 'active', sound: 'zip' })
  })

  test('having admin among other roles still activates it', () => {
    expect(poke(['author', 'admin']).status).toBe('active')
  })
})
