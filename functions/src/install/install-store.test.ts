/**
 * `/install`'s commit and the proposal approval, by behaviour
 * (SOVEREIGN-PLAN.md Phase 1).
 *
 * Both were Firestore batches/transactions pinned by regexes over the source
 * (endpoint-wiring.test.ts). These run the real kernel against MemoryStore.
 *
 * Run: cd functions && bun test src/install/install-store.test.ts
 */
import { describe, test, expect } from 'bun:test'

import { MemoryStore } from '../collections/store'
import type { InstallRecords } from './apply'
import type { Proposal } from './proposal'
import { ManifestConflict } from './manifest-identity'
import { commitInstall, updateProposalIf, EPOCH_DOC } from './install-store'

const NOW = '2026-10-24T12:00:00.000Z'
const manifest = { name: 'lib', version: '1.0.0', collections: { 'lib:thing': { access: {} } } }
const records = (over: Partial<InstallRecords> = {}): InstallRecords =>
  ({
    manifest: { id: 'lib@1.0.0', data: manifest },
    grant: { id: 'lib', data: { name: 'lib', activeVersion: '1.0.0', status: 'active' } },
    log: { id: 'log-1', data: { action: 'install' } },
    ...over,
  }) as unknown as InstallRecords

describe('commitInstall', () => {
  test('writes manifest, grant, log and bumps the epoch, together', async () => {
    const store = new MemoryStore()
    await commitInstall(store, records(), NOW)
    expect(store.paths().sort()).toEqual(['grant/lib', 'install-log/log-1', 'manifest/lib@1.0.0', EPOCH_DOC].sort())
    expect((await store.get(EPOCH_DOC)).data).toEqual({ value: 1, at: NOW })
  })

  test('the epoch counts up from what is stored, keeping other fields', async () => {
    const store = new MemoryStore({ [EPOCH_DOC]: { value: 41, note: 'kept' } })
    await commitInstall(store, records(), NOW)
    expect((await store.get(EPOCH_DOC)).data).toEqual({ value: 42, at: NOW, note: 'kept' })
  })

  test('an identical re-submission rewrites nothing in the manifest and proceeds', async () => {
    const stored = { ...manifest, installedBy: 'someone', installedAt: 'earlier' }
    const store = new MemoryStore({ 'manifest/lib@1.0.0': stored })
    await commitInstall(store, records({ manifest: { id: 'lib@1.0.0', data: { ...manifest, installedBy: 'me' } } }), NOW)
    expect((await store.get('manifest/lib@1.0.0')).data).toEqual(stored)
    expect((await store.get('grant/lib')).exists).toBe(true)
  })

  test('a version re-submitted with DIFFERENT content is a conflict, and writes nothing', async () => {
    const store = new MemoryStore({ 'manifest/lib@1.0.0': manifest })
    const swapped = { ...manifest, collections: { 'lib:thing': { access: { public: { write: ['*'] } } } } }
    await expect(
      commitInstall(store, records({ manifest: { id: 'lib@1.0.0', data: swapped } }), NOW)
    ).rejects.toBeInstanceOf(ManifestConflict)
    expect(store.paths()).toEqual(['manifest/lib@1.0.0'])
  })

  test('a revoke (no manifest record) never touches a stored manifest', async () => {
    const store = new MemoryStore({ 'manifest/lib@1.0.0': manifest })
    await commitInstall(store, records({ manifest: null }), NOW)
    expect((await store.get('manifest/lib@1.0.0')).data).toEqual(manifest)
    expect((await store.get(EPOCH_DOC)).data.value).toBe(1)
  })

  test('concurrent installs of one version: the epoch counts both, the manifest is written once', async () => {
    const store = new MemoryStore()
    await Promise.all([
      commitInstall(store, records(), NOW),
      commitInstall(store, records({ log: { id: 'log-2', data: {} } }), NOW),
    ])
    expect((await store.get(EPOCH_DOC)).data.value).toBe(2)
    expect(store.paths().filter((p) => p.startsWith('install-log/'))).toEqual(['install-log/log-1', 'install-log/log-2'])
  })
})

describe('updateProposalIf', () => {
  const pending = { status: 'pending', code: 'ABCD', result: { old: true } } as unknown as Proposal
  const isPending = (p: Proposal | null) => (p as { status?: string } | null)?.status === 'pending'

  test('applies the change when allowed, replacing a named map field WHOLE', async () => {
    const store = new MemoryStore({ 'p/1': pending as unknown as Record<string, unknown> })
    const change = { status: 'approved', result: { new: true } } as unknown as Partial<Proposal>
    expect(await updateProposalIf(store, 'p/1', isPending, change)).toBe(true)
    expect((await store.get('p/1')).data).toEqual({ status: 'approved', code: 'ABCD', result: { new: true } })
  })

  test('single use: the second approval sees it already taken', async () => {
    const store = new MemoryStore({ 'p/1': pending as unknown as Record<string, unknown> })
    const take = () => updateProposalIf(store, 'p/1', isPending, { status: 'approved' } as unknown as Partial<Proposal>)
    expect((await Promise.all([take(), take()])).sort()).toEqual([false, true])
  })

  test('a missing proposal is never created', async () => {
    const store = new MemoryStore()
    expect(await updateProposalIf(store, 'p/none', () => true, { status: 'approved' } as unknown as Partial<Proposal>)).toBe(false)
    expect(store.paths()).toEqual([])
  })
})
