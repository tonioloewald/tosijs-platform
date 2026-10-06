import { describe, expect, test } from 'bun:test'
import { SWEEP_BATCH, SWEEP_GRACE_MS, isSweepable, memorySweepable, sweepCutoff, sweepExpired, type Sweepable } from './sweep'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const iso = (ms: number) => new Date(ms).toJSON()

describe('isSweepable', () => {
  test('not before expiry, and not within the grace period after it', () => {
    expect(isSweepable(iso(NOW + 1), NOW)).toBe(false)
    expect(isSweepable(iso(NOW - 1), NOW)).toBe(false)
    expect(isSweepable(iso(NOW - SWEEP_GRACE_MS), NOW)).toBe(false)
    expect(isSweepable(iso(NOW - SWEEP_GRACE_MS - 1), NOW)).toBe(true)
  })
  test('an expiry that is not a date is deletable, never kept forever', () => {
    for (const bad of ['not a date', undefined, null, 42, {}]) expect(isSweepable(bad, NOW)).toBe(true)
  })
  test('the store cutoff and the rule agree on real expiries', () => {
    for (const offset of [-3 * SWEEP_GRACE_MS, -SWEEP_GRACE_MS - 1, -SWEEP_GRACE_MS, -1, 1, SWEEP_GRACE_MS]) {
      const expiresAt = iso(NOW + offset)
      expect(expiresAt < sweepCutoff(NOW)).toBe(isSweepable(expiresAt, NOW))
    }
  })
})

describe('sweepExpired', () => {
  test('deletes what is long expired and nothing else', async () => {
    const rows = new Map<string, { expiresAt: unknown }>([
      ['old', { expiresAt: iso(NOW - 2 * SWEEP_GRACE_MS) }],
      ['just-expired', { expiresAt: iso(NOW - 1000) }], // an approval may still be writing its outcome
      ['live', { expiresAt: iso(NOW + 60_000) }],
    ])
    expect(await sweepExpired(memorySweepable(rows), NOW)).toBe(1)
    expect([...rows.keys()]).toEqual(['just-expired', 'live'])
  })

  test('a batch per call, so deleting outpaces creating', async () => {
    const rows = new Map<string, { expiresAt: unknown }>()
    for (let i = 0; i < SWEEP_BATCH + 30; i++) rows.set(`r${i}`, { expiresAt: iso(NOW - 2 * SWEEP_GRACE_MS - i) })
    expect(SWEEP_BATCH).toBeGreaterThan(1)
    expect(await sweepExpired(memorySweepable(rows), NOW)).toBe(SWEEP_BATCH)
    expect(await sweepExpired(memorySweepable(rows), NOW)).toBe(30)
    expect(rows.size).toBe(0)
  })

  test('never throws: cleanup must not fail the request that triggered it', async () => {
    const errors: unknown[] = []
    const broken: Sweepable = {
      expiredBefore: async () => {
        throw new Error('firestore is down')
      },
      remove: async () => undefined,
    }
    expect(await sweepExpired(broken, NOW, (e) => errors.push(e))).toBe(0)
    expect(errors).toHaveLength(1)
    const cannotDelete: Sweepable = {
      expiredBefore: async () => [{ id: 'a', expiresAt: iso(NOW - 2 * SWEEP_GRACE_MS) }],
      remove: async () => {
        throw new Error('denied')
      },
    }
    expect(await sweepExpired(cannotDelete, NOW, (e) => errors.push(e))).toBe(0)
    expect(errors).toHaveLength(2)
  })
})
