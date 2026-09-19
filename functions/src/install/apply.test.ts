/**
 * Install decisions (A3, #5).
 *
 * Installing turns a JSON document into collection config, schemas and access
 * rules on somebody's host, so these tests are about what it REFUSES.
 *
 * The upgrade path gets most of the attention, because that is the dangerous
 * one: a first install is a human approving a manifest they just read; an
 * upgrade is a human approving something they approved months ago whose
 * contents have since changed. That is where a library quietly acquires a
 * collection or widens a limit.
 *
 * Run: cd functions && bun test src/install/apply.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { unenforcedKeywords } from 'tosijs-schema'

import {
  decideInstall,
  decideRevoke,
  additiveProblems,
  addedCapabilities,
  type Grant,
} from './apply'
import type { Manifest } from './manifest'
import { ROLES } from '../collections/roles'

const validate = {
  unenforced: (s: Record<string, unknown>) =>
    unenforcedKeywords(s as never) as string[],
  knownRoles: Object.values(ROLES),
}

const NOW = '2026-09-19T12:00:00.000Z'
const configurator = { uid: 'u1', roles: [ROLES.configurator] }

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  manifest: 1,
  name: 'virta',
  version: '1.0.0',
  collections: {
    'virta:task': {
      schema: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' } },
        required: ['title'],
      },
      access: [{ role: ROLES.admin, read: 'ALL', write: 'ALL', list: 'ALL' }],
    },
  },
  ...over,
})

const base = {
  existing: null,
  previousManifest: null,
  principal: configurator,
  nowIso: NOW,
  logId: 'log-1',
  validate,
}

describe('authority', () => {
  test('an unauthenticated caller is refused', () => {
    const d = decideInstall({ ...base, manifest: manifest(), principal: null })
    expect(d).toMatchObject({ status: 'refused' })
  })

  test('a non-configurator is refused — INCLUDING owner', () => {
    // owner's power is the datastore (D3/D14), not an in-system bypass. An
    // owner who wants to install grants themselves configurator, and that
    // grant is visible.
    for (const role of [ROLES.owner, ROLES.admin, ROLES.developer]) {
      const d = decideInstall({
        ...base,
        manifest: manifest(),
        principal: { uid: 'u', roles: [role] },
      })
      expect(d).toMatchObject({ status: 'refused' })
      expect((d as { problems: string[] }).problems.join()).toContain(
        'configurator'
      )
    }
  })

  test('a configurator installs', () => {
    const d = decideInstall({ ...base, manifest: manifest() })
    expect(d.status).toBe('installed')
  })
})

describe('an invalid manifest never reaches the store', () => {
  test('validation problems are returned, not written', () => {
    const d = decideInstall({
      ...base,
      manifest: manifest({ collections: { role: manifest().collections['virta:task'] } as never }),
    })
    expect(d.status).toBe('refused')
    expect((d as { problems: string[] }).problems.join()).toContain('platform collection')
  })

  test('a grant for a different namespace is refused', () => {
    const existing: Grant = {
      name: 'other',
      activeVersion: '1.0.0',
      status: 'active',
      capabilities: [],
    }
    const d = decideInstall({ ...base, manifest: manifest(), existing })
    expect((d as { problems: string[] }).problems.join()).toContain('is for "other"')
  })
})

describe('records written on a first install', () => {
  const d = decideInstall({ ...base, manifest: manifest() })
  const records = (d as { records: never }).records as {
    manifest: { id: string; data: Record<string, unknown> }
    grant: { id: string; data: Grant }
    log: { id: string; data: Record<string, unknown> }
  }

  test('the manifest is keyed name@version, so history is diffable later', () => {
    expect(records.manifest.id).toBe('virta@1.0.0')
    expect(records.manifest.data.installedBy).toBe('u1')
  })

  test('the grant activates and records who approved it', () => {
    expect(records.grant.data).toMatchObject({
      name: 'virta',
      activeVersion: '1.0.0',
      status: 'active',
      approvedBy: 'u1',
    })
  })

  test('the ledger records the act', () => {
    expect(records.log.data).toMatchObject({ action: 'install', by: 'u1' })
  })
})

describe('upgrades must be ADDITIVE — the dangerous path', () => {
  const v1 = manifest()
  const installed: Grant = {
    name: 'virta',
    activeVersion: '1.0.0',
    status: 'active',
    capabilities: [],
  }

  const upgrade = (next: Manifest) =>
    decideInstall({
      ...base,
      manifest: next,
      existing: installed,
      previousManifest: v1,
    })

  test('adding a collection is fine', () => {
    const next = manifest({
      version: '1.1.0',
      collections: {
        ...v1.collections,
        'virta:event': {
          schema: { type: 'object' },
          access: [{ role: ROLES.admin, read: 'ALL' }],
        },
      },
    })
    expect(upgrade(next).status).toBe('upgraded')
  })

  test('adding an OPTIONAL field is fine', () => {
    const next = manifest({
      version: '1.1.0',
      collections: {
        'virta:task': {
          ...v1.collections['virta:task'],
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              body: { type: 'string' },
              tags: { type: 'array' },
            },
            required: ['title'],
          },
        },
      },
    })
    expect(upgrade(next).status).toBe('upgraded')
  })

  test('REMOVING a collection is refused — that is a migration', () => {
    const next = manifest({ version: '2.0.0', collections: {} })
    const d = upgrade(next)
    expect(d.status).toBe('refused')
    expect((d as { problems: string[] }).problems.join()).toContain('was removed')
  })

  test('REMOVING a field is refused', () => {
    const next = manifest({
      version: '1.1.0',
      collections: {
        'virta:task': {
          ...v1.collections['virta:task'],
          schema: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
          },
        },
      },
    })
    expect((upgrade(next) as { problems: string[] }).problems.join()).toContain(
      'body" was removed'
    )
  })

  test('NEWLY REQUIRING a field is refused — stored docs would become invalid', () => {
    const next = manifest({
      version: '1.1.0',
      collections: {
        'virta:task': {
          ...v1.collections['virta:task'],
          schema: {
            ...v1.collections['virta:task'].schema,
            required: ['title', 'body'],
          },
        },
      },
    })
    expect((upgrade(next) as { problems: string[] }).problems.join()).toContain(
      'newly required'
    )
  })

  test('changing a unique constraint is refused', () => {
    const next = manifest({
      version: '1.1.0',
      collections: {
        'virta:task': { ...v1.collections['virta:task'], unique: ['title'] },
      },
    })
    expect((upgrade(next) as { problems: string[] }).problems.join()).toContain(
      'unique constraint'
    )
  })
})

describe('capabilities re-trigger human approval when they grow', () => {
  const withCaps = (caps: Array<Record<string, unknown>>, version = '1.0.0') =>
    manifest({ version, capabilities: caps as never })

  const granted: Grant = {
    name: 'virta',
    activeVersion: '1.0.0',
    status: 'active',
    capabilities: [{ kind: 'blob', bucket: 'attachments', maxBytes: 1000 }],
  }

  test('an upgrade asking for NOTHING new just activates', () => {
    const d = decideInstall({
      ...base,
      manifest: withCaps([{ kind: 'blob', bucket: 'attachments', maxBytes: 1000 }], '1.1.0'),
      existing: granted,
      previousManifest: manifest(),
    })
    expect(d.status).toBe('upgraded')
  })

  test('a NEW capability parks the upgrade as pending', () => {
    const d = decideInstall({
      ...base,
      manifest: withCaps(
        [
          { kind: 'blob', bucket: 'attachments', maxBytes: 1000 },
          { kind: 'outbound', host: 'api.github.com' },
        ],
        '1.1.0'
      ),
      existing: granted,
      previousManifest: manifest(),
    })
    expect(d.status).toBe('needs-approval')
    expect((d as { added: unknown[] }).added).toHaveLength(1)
  })

  test('a WIDENED argument counts as new — not the same capability', () => {
    // The quiet escalation this exists to stop: same `kind`, bigger limit.
    // Comparing on kind alone would let an upgrade raise a ceiling a human
    // approved at a lower value.
    const d = decideInstall({
      ...base,
      manifest: withCaps([{ kind: 'blob', bucket: 'attachments', maxBytes: 999999 }], '1.1.0'),
      existing: granted,
      previousManifest: manifest(),
    })
    expect(d.status).toBe('needs-approval')
  })

  test('a pending upgrade does NOT change what is live', () => {
    const d = decideInstall({
      ...base,
      manifest: withCaps(
        [
          { kind: 'blob', bucket: 'attachments', maxBytes: 1000 },
          { kind: 'outbound', host: 'api.github.com' },
        ],
        '1.1.0'
      ),
      existing: granted,
      previousManifest: manifest(),
    })
    const grant = (d as { records: { grant: { data: Grant } } }).records.grant.data
    // Still on the old version, still the old capabilities. The new manifest is
    // recorded; nothing it asked for takes effect until a human says so.
    expect(grant.activeVersion).toBe('1.0.0')
    expect(grant.status).toBe('pending')
    expect(grant.capabilities).toEqual(granted.capabilities)
  })

  test('addedCapabilities ignores key ORDER but not values', () => {
    expect(
      addedCapabilities(
        [{ kind: 'blob', maxBytes: 1 }],
        [{ maxBytes: 1, kind: 'blob' }]
      )
    ).toEqual([])
    expect(
      addedCapabilities([{ kind: 'blob', maxBytes: 1 }], [{ kind: 'blob', maxBytes: 2 }])
    ).toHaveLength(1)
  })
})

describe('revoking never drops rows', () => {
  const granted: Grant = {
    name: 'virta',
    activeVersion: '1.0.0',
    status: 'active',
    capabilities: [],
  }

  test('it tombstones the grant and keeps it enumerable', () => {
    const d = decideRevoke(granted, configurator, NOW, 'log-2')
    const grant = (d as { records: { grant: { data: Grant } } }).records.grant.data
    expect(grant.status).toBe('revoked')
    expect(grant.revokedAt).toBe(NOW)
    // Still there, still naming its version — a re-install restores the same
    // library to the same collections, and the DATA was never touched.
    expect(grant.name).toBe('virta')
    expect(grant.activeVersion).toBe('1.0.0')
  })

  test('a non-configurator cannot revoke', () => {
    expect(
      decideRevoke(granted, { uid: 'u', roles: [ROLES.owner] }, NOW, 'log-2')
    ).toMatchObject({ status: 'refused' })
  })
})

describe('additiveProblems in isolation', () => {
  test('an identical manifest has no problems', () => {
    expect(additiveProblems(manifest(), manifest())).toEqual([])
  })
})
