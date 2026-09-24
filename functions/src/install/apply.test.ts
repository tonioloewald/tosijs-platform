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
  type InstallRecords,
  type CapabilityEntry,
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
      capabilities: {},
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
    capabilities: {},
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
  const BLOB = { kind: 'blob', bucket: 'attachments', maxBytes: 1000 }
  const OUTBOUND = { kind: 'outbound', host: 'api.github.com' }

  const withCaps = (
    caps: Record<string, Record<string, unknown>>,
    version = '1.0.0'
  ) => manifest({ version, capabilities: caps as never })

  const granted: Grant = {
    name: 'virta',
    activeVersion: '1.0.0',
    status: 'active',
    capabilities: { 'virta:files': BLOB } as never,
  }

  const upgrade = (
    caps: Record<string, Record<string, unknown>>,
    approving?: Record<string, Record<string, unknown>>
  ) =>
    decideInstall({
      ...base,
      manifest: withCaps(caps, '1.1.0'),
      existing: granted,
      previousManifest: manifest(),
      ...(approving ? { approving: approving as never } : {}),
    })

  test('an upgrade asking for NOTHING new just activates', () => {
    expect(upgrade({ 'virta:files': BLOB }).status).toBe('upgraded')
  })

  test('key ORDER in a declaration is not a change', () => {
    // A manifest arrives as JSON from a file nobody treats as ordered.
    // Spurious re-approval prompts are how people learn to stop reading them.
    expect(
      upgrade({
        'virta:files': { maxBytes: 1000, bucket: 'attachments', kind: 'blob' },
      }).status
    ).toBe('upgraded')
  })

  test('a NEW capability parks the upgrade as pending', () => {
    const d = upgrade({ 'virta:files': BLOB, 'virta:notify': OUTBOUND })
    expect(d.status).toBe('needs-approval')
    expect((d as { added: CapabilityEntry[] }).added).toHaveLength(1)
    expect((d as { added: CapabilityEntry[] }).added[0].name).toBe('virta:notify')
  })

  test('a WIDENED argument counts as new — not the same capability', () => {
    // The quiet escalation this exists to stop: same `kind`, same NAME, bigger
    // limit. Comparing on kind or name alone would let an upgrade raise a
    // ceiling a human approved at a lower value.
    const d = upgrade({ 'virta:files': { ...BLOB, maxBytes: 999999 } })
    expect(d.status).toBe('needs-approval')
  })

  test('a WIDENED ACCESS RULE counts as new — the reason access lives inside', () => {
    // Opening a capability from admin to public is at least as dangerous as
    // raising a byte limit. If the rules lived beside the declaration instead
    // of in it, this upgrade would activate silently.
    const locked = { ...BLOB, access: [{ role: ROLES.admin, use: 'ALL' }] }
    const opened = { ...BLOB, access: [{ role: ROLES.public, use: 'ALL' }] }
    const withLocked: Grant = {
      ...granted,
      capabilities: { 'virta:files': locked } as never,
    }
    const d = decideInstall({
      ...base,
      manifest: withCaps({ 'virta:files': opened }, '1.1.0'),
      existing: withLocked,
      previousManifest: manifest(),
    })
    expect(d.status).toBe('needs-approval')
  })

  test('a pending upgrade does NOT change what is live', () => {
    const d = upgrade({ 'virta:files': BLOB, 'virta:notify': OUTBOUND })
    const grant = (d as { records: { grant: { data: Grant } } }).records.grant.data
    // Still on the old version, still the old capabilities. The new manifest is
    // recorded; nothing it asked for takes effect until a human says so.
    expect(grant.activeVersion).toBe('1.0.0')
    expect(grant.status).toBe('pending')
    expect(grant.capabilities).toEqual(granted.capabilities)
  })

  test('approving the exact capability applies the upgrade', () => {
    const d = upgrade(
      { 'virta:files': BLOB, 'virta:notify': OUTBOUND },
      { 'virta:notify': OUTBOUND }
    )
    expect(d.status).toBe('upgraded')
    const grant = (d as { records: { grant: { data: Grant } } }).records.grant.data
    expect(grant.activeVersion).toBe('1.1.0')
    expect(Object.keys(grant.capabilities)).toHaveLength(2)
  })

  test('approval names CONTENT, not a name — a near-miss does not count', () => {
    // Approving by name would approve whatever that name means when the
    // approval lands. Here the human approved api.github.com and the manifest
    // now asks, under the same name, for somewhere else.
    const d = upgrade(
      { 'virta:files': BLOB, 'virta:notify': { kind: 'outbound', host: 'evil.example' } },
      { 'virta:notify': OUTBOUND }
    )
    expect(d.status).toBe('needs-approval')
    expect((d as { added: CapabilityEntry[] }).added[0].capability).toMatchObject({
      host: 'evil.example',
    })
  })

  test('a PARTIAL approval leaves the rest outstanding, and applies nothing', () => {
    const d = upgrade(
      {
        'virta:files': BLOB,
        'virta:a': { kind: 'outbound', host: 'a.example' },
        'virta:b': { kind: 'outbound', host: 'b.example' },
      },
      { 'virta:a': { kind: 'outbound', host: 'a.example' } }
    )
    expect(d.status).toBe('needs-approval')
    expect((d as { added: CapabilityEntry[] }).added.map((e) => e.name)).toEqual([
      'virta:b',
    ])
    // The approved half is NOT granted in the meantime — approval is all or
    // nothing, so a half-applied upgrade can never be live.
    const grant = (d as { records: { grant: { data: Grant } } }).records.grant.data
    expect(grant.capabilities).toEqual(granted.capabilities)
  })

  test('the ledger records the real diff AND what was signed off', () => {
    const d = upgrade(
      { 'virta:files': BLOB, 'virta:notify': OUTBOUND },
      { 'virta:notify': OUTBOUND }
    )
    const log = (d as { records: { log: { data: Record<string, unknown> } } })
      .records.log.data
    expect(log.addedCapabilities).toHaveLength(1)
    expect(log.approvedCapabilities).toEqual({ 'virta:notify': OUTBOUND })
  })

  test('addedCapabilities on its own', () => {
    expect(addedCapabilities({ a: BLOB } as never, { a: BLOB } as never)).toEqual([])
    expect(
      addedCapabilities({ a: BLOB } as never, {
        a: { ...BLOB, maxBytes: 2 },
      } as never)
    ).toHaveLength(1)
    // A capability that DISAPPEARS is not an addition — losing power needs no
    // approval.
    expect(addedCapabilities({ a: BLOB } as never, {} as never)).toEqual([])
  })
})

describe('revoking never drops rows', () => {
  const granted: Grant = {
    name: 'virta',
    activeVersion: '1.0.0',
    status: 'active',
    capabilities: {},
  }

  test('it writes NO manifest record — the diff basis must survive', () => {
    // A handler given `{id, data: {}}` would write that over the stored
    // manifest and erase it. The next install of the same library would then
    // have nothing to run the additive-only check against, and would be waved
    // through. Null is the only shape that cannot be committed by accident.
    const d = decideRevoke(granted, configurator, NOW, 'log-2')
    expect((d as { records: InstallRecords }).records.manifest).toBeNull()
  })

  test('it tombstones the grant and keeps it enumerable', () => {
    const d = decideRevoke(granted, configurator, NOW, 'log-2')
    expect(d.status).toBe('revoked')
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

describe('a sequence cannot change under stored documents (#22)', () => {
  const task = manifest().collections['virta:task']
  const withEnvelope = (extra: Record<string, unknown>) =>
    manifest({
      version: '1.0.1',
      collections: { 'virta:task': { ...task, ...extra } as never },
    })

  test('turning seq ON is refused — earlier documents would be invisible to since=', () => {
    // virta's case: ten writes at 0.1.1, seq added at 0.1.2, and `since=0`
    // answered "nothing" with no error anywhere.
    const problems = additiveProblems(
      manifest(),
      withEnvelope({ envelope: { seq: true } })
    )
    expect(problems.join()).toContain('turned envelope.seq ON')
    expect(problems.join()).toContain('new name')
  })

  test('turning seq OFF is refused — replicas would silently stop receiving', () => {
    const problems = additiveProblems(
      withEnvelope({ envelope: { seq: true } }),
      withEnvelope({ envelope: { seq: false } })
    )
    expect(problems.join()).toContain('turned envelope.seq OFF')
  })

  test('keeping seq as it was is fine, as is a NEW collection that declares it', () => {
    const seq = withEnvelope({ envelope: { seq: true } })
    expect(additiveProblems(seq, seq)).toEqual([])
    const added = manifest({
      version: '1.0.1',
      collections: {
        ...manifest().collections,
        'virta:event': { ...task, envelope: { seq: true } } as never,
      },
    })
    expect(additiveProblems(manifest(), added)).toEqual([])
  })

  test('immutable may be ADDED — it only restricts future writes', () => {
    const imm = withEnvelope({ immutable: true })
    expect(additiveProblems(manifest(), imm)).toEqual([])
    expect(additiveProblems(imm, imm)).toEqual([])
  })

  test('but never DROPPED — stored documents were promised never to change (F2)', () => {
    const imm = withEnvelope({ immutable: true })
    for (const after of [manifest({ version: '1.0.2' }), withEnvelope({ immutable: false })]) {
      expect(additiveProblems(imm, after).join()).toContain('dropped immutable')
    }
  })

  test('the refusal reaches the install decision', () => {
    const d = decideInstall({
      ...base,
      manifest: withEnvelope({ envelope: { seq: true } }),
      existing: { name: 'virta', activeVersion: '1.0.0' } as never,
      previousManifest: manifest(),
    } as never)
    expect(d.status).toBe('refused')
    expect((d as { problems: string[] }).problems.join()).toContain('envelope.seq')
  })
})
