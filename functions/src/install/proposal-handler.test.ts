/**
 * The install-proposal flow, run for real: the handler, the pure decisions and
 * the real install decision (`decideInstall`), over an in-memory store and
 * grant. What the 0.4.0 review found (B1) and the re-review asked for (R1): a
 * test that fails when the flow in the handler is wrong, not only its helpers.
 */
import { describe, expect, test } from 'bun:test'
import { approveProposal, proposeManifest, type Install, type InstallResult, type ProposalStore } from './proposal-handler'
import { decideInstall, type Grant } from './apply'
import type { Manifest } from './manifest'
import { MAX_PROPOSAL_BYTES, PROPOSAL_TTL_MS, proposalState, type Proposal } from './proposal'
import { SWEEP_GRACE_MS, memorySweepable } from '../sweep'
import { ROLES } from '../collections/roles'
import { unenforcedKeywords } from 'tosijs-schema'

// The same options the endpoint passes.
const validate = {
  unenforced: (schema: unknown) => unenforcedKeywords(schema as never) as string[],
  knownRoles: Object.values(ROLES),
}

const NOW = Date.parse('2026-10-07T12:00:00Z')
const random = new Uint8Array(8).fill(7)
const configurator = { uid: 'u-config', roles: [ROLES.configurator] }
const BLOB = { kind: 'blob', bucket: 'attachments', maxBytes: 1000 }
const OUTBOUND = { kind: 'outbound', host: 'api.github.com' }

const manifest = (version: string, capabilities?: Record<string, unknown>): Manifest =>
  ({
    manifest: 1,
    name: 'demo',
    version,
    collections: {
      'demo:task': {
        schema: { type: 'object', properties: { title: { type: 'string' } } },
        access: [{ role: ROLES.admin, read: 'ALL', write: 'ALL', list: 'ALL' }],
      },
    },
    ...(capabilities ? { capabilities } : {}),
  }) as unknown as Manifest

const memoryStore = () => {
  const rows = new Map<string, Proposal>()
  let n = 0
  const store: ProposalStore = {
    ...memorySweepable(rows as Map<string, { expiresAt: unknown }>),
    async create(p) {
      const id = `proposal-${String(++n).padStart(4, '0')}`
      rows.set(id, structuredClone(p))
      return id
    },
    async read(id) {
      const p = rows.get(id)
      return p ? structuredClone(p) : null
    },
    async updateIf(id, allow, change) {
      const current = rows.get(id) ?? null
      if (!allow(current)) return false
      if (!current) throw new Error('NOT_FOUND') // as a Firestore update of a missing document
      rows.set(id, { ...current, ...change })
      return true
    },
  }
  return { rows, store }
}

/** A host: the real decision, with the grant and the manifests kept in memory. */
const memoryHost = () => {
  const state = { grant: null as Grant | null, manifests: new Map<string, Manifest>(), log: [] as unknown[], calls: [] as Array<{ dryRun: boolean; approving: unknown }> }
  const install: Install = async ({ manifest: m, principal, approving, dryRun }) => {
    state.calls.push({ dryRun: !!dryRun, approving })
    const decision = decideInstall({
      manifest: m,
      existing: state.grant,
      previousManifest: state.grant?.activeVersion ? (state.manifests.get(state.grant.activeVersion) ?? null) : null,
      principal,
      nowIso: new Date(NOW).toJSON(),
      logId: `log-${state.log.length + 1}`,
      validate,
      approving: approving as never,
    })
    if (decision.status === 'refused') {
      return { httpStatus: 400, error: 'refused', message: 'the manifest was refused', extra: { problems: decision.problems } }
    }
    if (!dryRun) {
      state.grant = decision.records.grant.data
      state.log.push(decision.records.log.data)
      if (decision.status !== 'needs-approval') state.manifests.set((m as Manifest).version, m as Manifest)
    }
    if (decision.status === 'needs-approval') {
      return { httpStatus: 202, body: { status: 'needs-approval', name: 'demo', added: decision.added } }
    }
    return { httpStatus: 200, body: { status: decision.status, name: 'demo', version: (m as Manifest).version } }
  }
  return { state, install }
}

const setup = () => {
  const { rows, store } = memoryStore()
  const host = memoryHost()
  const errors: string[] = []
  const deps = {
    store,
    install: host.install,
    conflictMessage: (e: unknown) => (e instanceof Error && e.message.startsWith('conflict:') ? e.message : null),
    onError: (what: string) => void errors.push(what),
  }
  const proposeIt = async (m: unknown, at = NOW) => {
    const r = await proposeManifest(deps, m, at, random)
    if (r.status !== 'ok') throw new Error(`refused: ${r.reason}`)
    return r.id
  }
  const approve = (id: string, at = NOW) => approveProposal(deps, { id, principal: configurator, nowMs: at })
  return { rows, store, host, errors, deps, proposeIt, approve }
}

describe('approving a proposal', () => {
  test('a new install: installed, recorded, and the grant is active', async () => {
    const t = setup()
    const id = await t.proposeIt(manifest('1.0.0'))
    const r = await t.approve(id)
    expect(r.error).toBeUndefined()
    expect(r.body?.status).toBe('installed')
    expect(t.host.state.grant).toMatchObject({ status: 'active', activeVersion: '1.0.0' })
    expect(t.rows.get(id)).toMatchObject({ status: 'installed', decidedBy: 'u-config' })
  })

  test('an upgrade that ADDS A CAPABILITY is applied, not parked (0.4.0 review B1)', async () => {
    const t = setup()
    await t.approve(await t.proposeIt(manifest('1.0.0', { 'demo:files': BLOB })))
    const id = await t.proposeIt(manifest('1.1.0', { 'demo:files': BLOB, 'demo:notify': OUTBOUND }))
    const r = await t.approve(id)

    expect(r.error).toBeUndefined()
    expect(r.body?.status).toBe('upgraded')
    // The grant itself: the new version is ACTIVE with the new capability.
    expect(t.host.state.grant).toMatchObject({ status: 'active', activeVersion: '1.1.0' })
    expect(Object.keys(t.host.state.grant?.capabilities ?? {}).sort()).toEqual(['demo:files', 'demo:notify'])
    expect(t.rows.get(id)?.status).toBe('installed')
    // It asked first without committing, then approved exactly what was outstanding.
    const [ask, real] = t.host.state.calls.slice(-2)
    expect(ask).toEqual({ dryRun: true, approving: undefined })
    expect(real).toEqual({ dryRun: false, approving: { 'demo:notify': OUTBOUND } })
  })

  test('still needing approval is a conflict, never "installed"', async () => {
    const t = setup()
    await t.approve(await t.proposeIt(manifest('1.0.0', { 'demo:files': BLOB })))
    const id = await t.proposeIt(manifest('1.1.0', { 'demo:files': BLOB, 'demo:notify': OUTBOUND }))
    // An installer that never accepts the approval (what is granted changed under it).
    const stubborn: Install = (input) => t.host.install({ ...input, approving: undefined })
    const r = await approveProposal({ ...t.deps, install: stubborn }, { id, principal: configurator, nowMs: NOW })

    expect(r).toMatchObject({ httpStatus: 409, error: 'conflict' })
    expect(t.rows.get(id)?.status).toBe('refused')
    expect(t.host.state.grant?.activeVersion).toBe('1.0.0')
  })

  test('single use: a second approval finds nothing pending and installs nothing', async () => {
    const t = setup()
    const id = await t.proposeIt(manifest('1.0.0'))
    await t.approve(id)
    const calls = t.host.state.calls.length
    expect(await t.approve(id)).toMatchObject({ httpStatus: 404, error: 'not-found' })
    expect(t.host.state.calls.length).toBe(calls)
  })

  test('an expired or unknown proposal is not approved', async () => {
    const t = setup()
    const id = await t.proposeIt(manifest('1.0.0'))
    expect(await t.approve(id, NOW + PROPOSAL_TTL_MS + 1)).toMatchObject({ httpStatus: 404 })
    expect(await t.approve('proposal-9999')).toMatchObject({ httpStatus: 404 })
    expect(t.host.state.grant).toBeNull()
  })

  test('a refused manifest is recorded as refused, with its problems', async () => {
    const t = setup()
    const id = await t.proposeIt({ manifest: 1, name: 'demo', version: 'not a version', collections: {} })
    const r = await t.approve(id)
    expect(r.error).toBe('refused')
    expect(t.rows.get(id)).toMatchObject({ status: 'refused' })
    expect(t.host.state.grant).toBeNull()
  })

  test('an installer that throws is a 500 (or a 409 for a version conflict), recorded as refused', async () => {
    const t = setup()
    const boom = (message: string): Install => async (input) => {
      if (input.dryRun) return { httpStatus: 200, body: { status: 'installed' } } as InstallResult
      throw new Error(message)
    }
    const a = await t.proposeIt(manifest('1.0.0'))
    expect(await approveProposal({ ...t.deps, install: boom('disk on fire') }, { id: a, principal: configurator, nowMs: NOW })).toMatchObject({ httpStatus: 500, error: 'internal' })
    expect(t.rows.get(a)?.status).toBe('refused')
    expect(t.errors).toContain('approving an install proposal')
    const b = await t.proposeIt(manifest('1.0.0'))
    expect(await approveProposal({ ...t.deps, install: boom('conflict: already on file') }, { id: b, principal: configurator, nowMs: NOW })).toMatchObject({ httpStatus: 409, error: 'conflict' })
  })

  test('the proposal vanishing mid-approval does not turn a committed install into an error (re-review)', async () => {
    const t = setup()
    const id = await t.proposeIt(manifest('1.0.0'))
    const vanishing: Install = async (input) => {
      const r = await t.host.install(input)
      if (!input.dryRun) t.rows.delete(id)
      return r
    }
    const r = await approveProposal({ ...t.deps, install: vanishing }, { id, principal: configurator, nowMs: NOW })
    expect(r.body?.status).toBe('installed')
    expect(t.host.state.grant?.status).toBe('active')
  })
  test('failing to RECORD the outcome does not change the answer: the install already happened', async () => {
    const t = setup()
    const id = await t.proposeIt(manifest('1.0.0'))
    let writes = 0
    const flaky = {
      ...t.store,
      updateIf: (...args: Parameters<ProposalStore['updateIf']>) => {
        if (++writes === 2) throw new Error('firestore unavailable')
        return t.store.updateIf(...args)
      },
    }
    const r = await approveProposal({ ...t.deps, store: flaky }, { id, principal: configurator, nowMs: NOW })
    expect(r.body?.status).toBe('installed')
    expect(t.host.state.grant?.status).toBe('active')
    expect(t.errors).toContain('recording an install proposal outcome')
  })
})

describe('proposing', () => {
  test('refuses what is not a manifest and what is too large, storing nothing', async () => {
    const t = setup()
    expect(await proposeManifest(t.deps, 'nope', NOW, random)).toEqual({ status: 'refused', reason: 'not-a-manifest' })
    const big = { ...manifest('1.0.0'), description: 'x'.repeat(MAX_PROPOSAL_BYTES) }
    expect(await proposeManifest(t.deps, big, NOW, random)).toEqual({ status: 'refused', reason: 'too-large' })
    expect(t.rows.size).toBe(0)
  })

  test('cleans up after itself: a flood leaves only what has not long expired (0.4.0 review B3)', async () => {
    const t = setup()
    for (let i = 0; i < 120; i++) await t.proposeIt(manifest(`1.0.${i}`))
    expect(t.rows.size).toBe(120)
    // Much later, more arrive: each deletes a batch of the old ones.
    const later = NOW + PROPOSAL_TTL_MS + SWEEP_GRACE_MS + 1000
    for (let i = 0; i < 3; i++) await t.proposeIt(manifest(`2.0.${i}`), later)
    expect(t.rows.size).toBe(3)
    for (const p of t.rows.values()) expect(proposalState(p, later)).toBe('pending')
  })

  test('there is no cap: many pending proposals never refuse a new one (no lockout lever)', async () => {
    const t = setup()
    for (let i = 0; i < 200; i++) await t.proposeIt(manifest(`1.0.${i}`))
    expect((await proposeManifest(t.deps, manifest('9.9.9'), NOW, random)).status).toBe('ok')
  })

  test('a proposal just past expiry is not swept: an approval may still be recording its outcome', async () => {
    const t = setup()
    const id = await t.proposeIt(manifest('1.0.0'))
    await t.proposeIt(manifest('1.0.1'), NOW + PROPOSAL_TTL_MS + 1000)
    expect(t.rows.has(id)).toBe(true)
  })

  test('a failing sweep does not stop a proposal', async () => {
    const t = setup()
    const broken = {
      ...t.store,
      expiredBefore: async () => {
        throw new Error('down')
      },
    }
    expect((await proposeManifest({ store: broken, onError: t.deps.onError }, manifest('1.0.0'), NOW, random)).status).toBe('ok')
    expect(t.errors).toContain('sweeping expired install proposals')
  })
})
