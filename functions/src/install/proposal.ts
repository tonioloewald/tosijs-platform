/**
 * Install proposals (board #2490, D22) — pure decision logic.
 *
 * Installing needs `configurator`, which can never be carried by a token, so a
 * command line cannot hold it. Until now that meant pasting a browser ID token
 * into a terminal. Instead:
 *
 *   1. the CLI PROPOSES a manifest (no credentials). The host stores it,
 *      short-lived, and answers with a link and a confirmation code;
 *   2. a configurator opens the link, checks the code matches their terminal,
 *      signs in, sees a dry run of exactly what would happen, and approves;
 *   3. the host installs THE STORED manifest — never one the browser sends —
 *      through the same path as `POST /install`, as that person.
 *
 * What a proposal can and cannot do:
 * - Proposing is unauthenticated, so a proposal is INERT: nothing reads it but
 *   the approval page, and it expires. It is size-limited and rate-limited
 *   like any anonymous write.
 * - The approver, not the proposer, is the installer of record.
 * - The risk is being talked into approving a proposal you did not start (a
 *   link in a message). The confirmation code binds the page to a terminal you
 *   can see; the page says so, and shows everything the manifest declares.
 * - A proposal is single-use: approved, denied, refused or expired is final.
 */
import { createHash } from 'crypto'
import type { CapabilityEntry } from './apply'
import type { CapabilityDeclaration } from './manifest'

/** How long a proposal can be approved. */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000
/**
 * Largest manifest a proposal will hold (bytes of JSON). Proposing needs no
 * credentials, so this bounds what an anonymous caller can make the host store
 * per request (0.4.0 review B3; expired ones are swept, see sweep.ts). Real
 * manifests are a few KB.
 */
export const MAX_PROPOSAL_BYTES = 64 * 1024
/** `deciding`: an approval is in flight (set first, so a proposal is single-use even under two clicks). */
export type ProposalStatus = 'pending' | 'deciding' | 'installed' | 'denied' | 'refused'

export interface Proposal {
  manifest: unknown
  /** sha256 of the manifest JSON as stored: what was approved is what was proposed. */
  hash: string
  /** Shown in the terminal and on the page; the human checks they match. */
  code: string
  status: ProposalStatus
  createdAt: string
  expiresAt: string
  /** The install's answer, once decided (what the CLI's poll returns). */
  result?: Record<string, unknown>
  decidedBy?: string
  decidedAt?: string
}

export type ProposeOutcome =
  | { status: 'ok'; proposal: Proposal }
  | { status: 'refused'; reason: 'not-a-manifest' | 'too-large' }

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I

/** `XXXX-XXXX` from random bytes: easy to read aloud, hard to mistype. */
export function confirmationCode(random: Uint8Array): string {
  const chars = [...random.slice(0, 8)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}`
}

export function propose(manifest: unknown, nowMs: number, random: Uint8Array): ProposeOutcome {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { status: 'refused', reason: 'not-a-manifest' }
  }
  const json = JSON.stringify(manifest)
  if (Buffer.byteLength(json) > MAX_PROPOSAL_BYTES) return { status: 'refused', reason: 'too-large' }
  return {
    status: 'ok',
    proposal: {
      manifest: JSON.parse(json),
      hash: createHash('sha256').update(json).digest('hex'),
      code: confirmationCode(random),
      status: 'pending',
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + PROPOSAL_TTL_MS).toISOString(),
    },
  }
}

export type ProposalState = 'pending' | 'expired' | 'missing' | ProposalStatus

/** What a proposal is, right now. Expiry is derived, never stored. */
export function proposalState(p: Proposal | null, nowMs: number): ProposalState {
  if (!p) return 'missing'
  if (p.status !== 'pending') return p.status
  const expires = Date.parse(p.expiresAt)
  // An unparseable expiry is expired, not eternal.
  if (!Number.isFinite(expires) || nowMs > expires) return 'expired'
  // The stored manifest must still be the one that was proposed.
  if (createHash('sha256').update(JSON.stringify(p.manifest)).digest('hex') !== p.hash) return 'expired'
  return 'pending'
}

/** The update that takes a pending proposal for one approver (single use). */
export const taken = (uid: string, nowIso: string): Partial<Proposal> => ({
  status: 'deciding',
  decidedBy: uid,
  decidedAt: nowIso,
})

/**
 * What approving a proposal approves: exactly the capabilities the host said
 * are outstanding, as the name → declaration record the installer matches BY
 * CONTENT. (The host reports them as a list; passing that list straight back
 * approved nothing, and the upgrade was recorded as installed while it was only
 * parked: 0.4.0 review B1.)
 */
export function approvingFrom(added: unknown): Record<string, CapabilityDeclaration> {
  const out: Record<string, CapabilityDeclaration> = {}
  if (!Array.isArray(added)) return out
  for (const entry of added as Array<Partial<CapabilityEntry> | null>) {
    if (entry && typeof entry === 'object' && typeof entry.name === 'string' && entry.capability) {
      out[entry.name] = entry.capability
    }
  }
  return out
}

/** The update recording a denial. */
export const denied = (nowIso: string): Partial<Proposal> => ({ status: 'denied', decidedAt: nowIso })

/**
 * The update recording how the install went: what the CLI's poll reports.
 * `failure` is set when the host refused or the install failed.
 */
export function decided(outcome: { body?: Record<string, unknown>; failure?: Record<string, unknown> }): Partial<Proposal> {
  return outcome.failure
    ? { status: 'refused', result: outcome.failure }
    : { status: 'installed', result: outcome.body ?? {} }
}

// ── what the page shows ──────────────────────────────────────────────────

export interface ManifestSummary {
  name: string
  version: string
  description?: string
  collections: Array<{
    name: string
    kind: 'collection' | 'storage area'
    /** e.g. "public: read, list" — every grant, nothing summarised away. */
    access: string[]
    notes: string[]
  }>
  capabilities: Array<{ name: string; kind: string }>
}

const rights = (grant: Record<string, unknown>): string => {
  const out: string[] = []
  for (const right of ['read', 'list', 'write', 'use']) {
    const v = grant[right]
    if (v === undefined) continue
    out.push(v === 'ALL' ? right : `${right} (conditional)`)
  }
  return out.join(', ') || 'nothing'
}

/**
 * A manifest as a human reads it. Tolerant of malformed input (it describes
 * what is there; the installer, not this, decides validity).
 */
export function summarize(manifest: unknown): ManifestSummary {
  const m = (manifest && typeof manifest === 'object' ? manifest : {}) as Record<string, any>
  const collections = Object.entries((m.collections ?? {}) as Record<string, any>).map(([name, c]) => {
    const notes: string[] = []
    if (c?.blob) {
      const types = Array.isArray(c.blob.contentTypes) ? c.blob.contentTypes.join(', ') : 'any type'
      notes.push(`files up to ${Math.round((Number(c.blob.maxBytes) || 0) / 1024)} KB; ${types}`)
    }
    if (c?.immutable) notes.push('immutable: documents cannot be changed or deleted')
    if (c?.envelope?.seq) notes.push('sequenced')
    if (Array.isArray(c?.unique) && c.unique.length) notes.push(`unique: ${c.unique.join(', ')}`)
    return {
      name,
      kind: (c?.blob ? 'storage area' : 'collection') as 'collection' | 'storage area',
      access: (Array.isArray(c?.access) ? c.access : []).map(
        (g: Record<string, unknown>) => `${String(g?.role ?? '?')}: ${rights(g ?? {})}`
      ),
      notes,
    }
  })
  const capabilities = Object.entries((m.capabilities ?? {}) as Record<string, any>).map(([name, c]) => ({
    name,
    kind: String(c?.kind ?? '?'),
  }))
  return {
    name: String(m.name ?? ''),
    version: String(m.version ?? ''),
    ...(typeof m.description === 'string' ? { description: m.description } : {}),
    collections,
    capabilities,
  }
}
