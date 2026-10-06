import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { MAX_PROPOSAL_BYTES, PROPOSAL_TTL_MS, approvingFrom, confirmationCode, decided, denied, propose, proposalState, summarize, taken, type Proposal } from './proposal'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const bytes = (n: number) => new Uint8Array(8).fill(n)
const manifest = { manifest: 1, name: 'demo', version: '1.0.0', collections: {} }
const ok = (m: unknown = manifest): Proposal => {
  const r = propose(m, NOW, bytes(3))
  if (r.status !== 'ok') throw new Error('expected a proposal')
  return r.proposal
}

describe('propose', () => {
  test('stores the manifest, its hash, a code and a 10-minute expiry', () => {
    const p = ok()
    expect(p.status).toBe('pending')
    expect(p.manifest).toEqual(manifest)
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(p.expiresAt) - Date.parse(p.createdAt)).toBe(PROPOSAL_TTL_MS)
  })
  test('refuses what is not a manifest object, and anything too large', () => {
    for (const bad of [null, 'x', 42, [], undefined]) {
      expect(propose(bad, NOW, bytes(1))).toEqual({ status: 'refused', reason: 'not-a-manifest' })
    }
    const big = { ...manifest, description: 'x'.repeat(MAX_PROPOSAL_BYTES) }
    expect(propose(big, NOW, bytes(1))).toEqual({ status: 'refused', reason: 'too-large' })
  })
  test('the confirmation code is XXXX-XXXX with no look-alike characters', () => {
    for (let i = 0; i < 256; i += 7) {
      const code = confirmationCode(new Uint8Array(8).map((_, j) => (i * 31 + j * 17) % 256))
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    }
  })
})

describe('proposalState', () => {
  test('pending until it expires; a missing one is missing', () => {
    const p = ok()
    expect(proposalState(p, NOW)).toBe('pending')
    expect(proposalState(p, NOW + PROPOSAL_TTL_MS)).toBe('pending')
    expect(proposalState(p, NOW + PROPOSAL_TTL_MS + 1)).toBe('expired')
    expect(proposalState(null, NOW)).toBe('missing')
  })
  test('single use: a decided proposal is never pending again', () => {
    for (const status of ['installed', 'denied', 'refused'] as const) {
      expect(proposalState({ ...ok(), status }, NOW)).toBe(status)
    }
  })
  test('an unparseable expiry is expired, not eternal', () => {
    expect(proposalState({ ...ok(), expiresAt: 'soon' }, NOW)).toBe('expired')
  })
  test('a manifest that no longer matches its hash cannot be approved', () => {
    const p = ok()
    const tampered = { ...p, manifest: { ...manifest, name: 'other' } }
    expect(proposalState(tampered, NOW)).toBe('expired')
  })
})

describe('the recorded outcomes', () => {
  test('taken, denied and decided each end the proposal: none is pending again', () => {
    const p = ok()
    for (const update of [taken('u1', 'T'), denied('T'), decided({ body: { status: 'installed' } }), decided({ failure: { error: 'refused' } })]) {
      expect(proposalState({ ...p, ...update } as Proposal, NOW)).not.toBe('pending')
    }
  })
  test('decided records the install\'s answer, or the failure, for the CLI\'s poll', () => {
    expect(decided({ body: { status: 'upgraded', name: 'x' } })).toEqual({ status: 'installed', result: { status: 'upgraded', name: 'x' } })
    expect(decided({ failure: { error: 'refused', problems: ['p'] } })).toEqual({ status: 'refused', result: { error: 'refused', problems: ['p'] } })
  })
})

describe('summarize — what the approver reads', () => {
  test('the real blog manifest: both storage areas, every grant, the limits', () => {
    const blog = JSON.parse(readFileSync(new URL('../../../manifests/blog.json', import.meta.url), 'utf-8'))
    const s = summarize(blog)
    expect(s.name).toBe('blog')
    expect(s.collections.map((c) => `${c.name} (${c.kind})`)).toEqual(['blog:public (storage area)', 'blog:private (storage area)'])
    expect(s.collections[0].access).toContain('public: read, list')
    expect(s.collections[0].access).toContain('author: write')
    expect(s.collections[1].access.join()).not.toContain('public')
    expect(s.collections[0].notes[0]).toContain('files up to 25600 KB')
  })
  test('conditional grants, flags and capabilities are all shown', () => {
    const s = summarize({
      name: 'x',
      version: '2',
      collections: {
        'x:log': {
          immutable: true,
          envelope: { seq: true },
          unique: ['slug'],
          access: [{ role: 'public', list: { visible: { field: 'date', op: 'nonEmpty' } } }],
        },
      },
      capabilities: { 'x:mail': { kind: 'email' } },
    })
    expect(s.collections[0].access).toEqual(['public: list (conditional)'])
    expect(s.collections[0].notes).toEqual(['immutable: documents cannot be changed or deleted', 'sequenced', 'unique: slug'])
    expect(s.capabilities).toEqual([{ name: 'x:mail', kind: 'email' }])
  })
  test('malformed input is described, not thrown on', () => {
    expect(summarize(null)).toEqual({ name: '', version: '', collections: [], capabilities: [] })
    expect(summarize({ collections: { a: null } }).collections[0]).toMatchObject({ name: 'a', access: [] })
  })
})

describe('approvingFrom (0.4.0 review B1)', () => {
  test('turns the reported list into the name → declaration record', () => {
    const added = [
      { name: 'a:files', capability: { kind: 'blob', maxBytes: 10 } },
      { name: 'a:notify', capability: { kind: 'outbound' } },
    ]
    expect(approvingFrom(added)).toEqual({
      'a:files': { kind: 'blob', maxBytes: 10 },
      'a:notify': { kind: 'outbound' },
    })
  })
  test('anything else approves nothing', () => {
    for (const bad of [undefined, null, {}, 'x', [null, 3, { capability: {} }]]) {
      expect(approvingFrom(bad)).toEqual({})
    }
  })
})

describe('what an anonymous caller can make the host store (0.4.0 review B3)', () => {
  test('one proposal is small; how they are deleted is sweep.test.ts and proposal-handler.test.ts', () => {
    expect(MAX_PROPOSAL_BYTES).toBeLessThanOrEqual(64 * 1024)
  })
})

describe('the approval page with a hostile manifest (0.4.0 review T11)', () => {
  test('nothing an anonymous proposer wrote reaches the page as markup', async () => {
    const { proposalPage } = await import('./proposal-page')
    const evil = '</script><script>alert(1)</script><img src=x onerror=alert(2)>"\'&'
    const p = ok({
      manifest: 1,
      name: evil,
      version: evil,
      description: evil,
      collections: { [evil]: { blob: { maxBytes: 1, contentTypes: [evil] }, unique: [evil], access: [{ role: evil, read: 'ALL' }] } },
      capabilities: { [evil]: { kind: evil } },
    })
    const html = proposalPage(p, 'pending', evil)
    // The page's own module script is the only script; the payload never opens one.
    expect(html.match(/<script/g)?.length).toBe(1)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('alert(1)</script>')
    // The request id is embedded as a JS string: it must not be able to end the script.
    const script = html.slice(html.indexOf('<script'))
    expect(script.indexOf('</script>')).toBe(script.length - '</script>'.length)
  })
})

