import { describe, test, expect, afterEach } from 'bun:test'
import {
  platformConfigsFrom,
  platformDocId,
  platformFromRegistry,
  missingPlatformConfigs,
  extraPlatformConfigs,
} from './platform-configs'
import { PLATFORM_CONFIGS } from '../collections/seed-configs'
import { compileStored } from '../collections/registry'

const doc = (name: string, extra: Record<string, unknown> = {}) => ({
  id: platformDocId(name),
  data: { name, collection: { schema: { type: 'object' }, access: [] }, ...extra },
})

describe('platformConfigsFrom — what a stored platform config may be', () => {
  test('bare names load, including a sub-collection config', () => {
    const out = platformConfigsFrom([doc('post'), doc('post/comment')])
    expect(out.map((c) => c.name)).toEqual(['post', 'post/comment'])
    expect(out.every((c) => c.namespace === null)).toBe(true)
  })

  test('the epoch document shares the collection and is skipped', () => {
    expect(platformConfigsFrom([{ id: 'epoch', data: { value: 3 } }])).toEqual([])
  })

  test('a NAMESPACED name is refused — libraries come from installs, never from here', () => {
    const errors: string[] = []
    const out = platformConfigsFrom(
      [{ id: 'virta:task', data: { name: 'virta:task', collection: {} } }],
      (m) => errors.push(m)
    )
    expect(out).toEqual([])
    expect(errors.join()).toContain('namespaced')
  })

  test('an id that does not match its name is refused — two docs cannot both claim `post`', () => {
    const errors: string[] = []
    const out = platformConfigsFrom(
      [{ id: 'post-copy', data: { name: 'post', collection: {} } }],
      (m) => errors.push(m)
    )
    expect(out).toEqual([])
    expect(errors.join()).toContain('ids must match names')
  })

  test('no name or no collection: ignored, not guessed', () => {
    const out = platformConfigsFrom([
      { id: 'x', data: {} },
      { id: 'post', data: { name: 'post' } },
      { id: 'y', data: undefined },
    ])
    expect(out).toEqual([])
  })

  test('the seed round-trips: every PLATFORM_CONFIG survives storage and compiles', () => {
    // What seed-registry.js writes is exactly `{name, collection}` at
    // platformDocId(name); this is the load half of that contract.
    const stored = PLATFORM_CONFIGS.map((c) => ({
      id: platformDocId(c.name),
      data: JSON.parse(JSON.stringify({ name: c.name, collection: c.collection })),
    }))
    const loaded = platformConfigsFrom(stored)
    expect(loaded.map((c) => c.name).sort()).toEqual(PLATFORM_CONFIGS.map((c) => c.name).sort())
    const { failed } = compileStored(loaded)
    expect(failed).toEqual([])
  })
})

describe('the switch', () => {
  const before = process.env.PLATFORM_CONFIGS_FROM_REGISTRY
  afterEach(() => {
    if (before === undefined) delete process.env.PLATFORM_CONFIGS_FROM_REGISTRY
    else process.env.PLATFORM_CONFIGS_FROM_REGISTRY = before
  })

  test('off unless explicitly "true" — a live blog is never switched by accident', () => {
    for (const v of [undefined, '', 'false', '1', 'yes', 'TRUE']) {
      if (v === undefined) delete process.env.PLATFORM_CONFIGS_FROM_REGISTRY
      else process.env.PLATFORM_CONFIGS_FROM_REGISTRY = v
      expect(platformFromRegistry()).toBe(false)
    }
    process.env.PLATFORM_CONFIGS_FROM_REGISTRY = 'true'
    expect(platformFromRegistry()).toBe(true)
  })
})

describe('missingPlatformConfigs — an unseeded or partial registry is loud', () => {
  test('nothing missing when every seed is present', () => {
    expect(missingPlatformConfigs(PLATFORM_CONFIGS)).toEqual([])
  })
  test('an empty registry reports every platform name', () => {
    expect(missingPlatformConfigs([]).sort()).toEqual(PLATFORM_CONFIGS.map((c) => c.name).sort())
  })
})

describe('extraPlatformConfigs — a stored config the code does not know is reported', () => {
  test('a stale post/comment is reported; the seeded set is not', () => {
    const stale = platformConfigsFrom([doc('post/comment')])
    expect(extraPlatformConfigs(stale)).toEqual(['post/comment'])
    expect(extraPlatformConfigs(PLATFORM_CONFIGS)).toEqual([])
  })
})
