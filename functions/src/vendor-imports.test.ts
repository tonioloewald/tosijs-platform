/**
 * The vendor ratchet (SOVEREIGN-PLAN.md Phase 1, epic #2863).
 *
 * The kernel must import no vendor SDK, so it can run on Firebase, on a single
 * box with SQLite, or scaled. Only adapters (`adapters/<vendor>/`) may import
 * one. Today many files still do; they are listed below, and the list may only
 * SHRINK:
 *
 * - a file not on the list that starts importing a vendor SDK fails here, which
 *   is SOVEREIGN.md §7's "stop adding Firebase-specific surface" made a test
 *   rather than a hope (it did not hold as a hope: 4 Firestore calls in
 *   September, 34 in October);
 * - a listed file that no longer imports one also fails, so the list is
 *   trimmed as files move behind ports and cannot quietly keep a stale entry.
 *
 * A static scan, like endpoint-options.test.ts.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const SRC = new URL('.', import.meta.url).pathname

/** Modules only an adapter may import. */
const VENDOR = /^(firebase-admin|firebase-functions|@google-cloud\/|@firebase\/|firebase$|firebase\/)/

/** Files outside `adapters/` that still import a vendor SDK (started 2026-10-22, 22 files). */
const NOT_YET_PORTED = [
  'auth/authorize-endpoint.ts',
  'auth/endpoint.ts',
  'blob-endpoint.ts',
  'cached-query.ts',
  'claim.ts',
  'doc.ts',
  'docs.ts',
  'esm.ts',
  'firestore-store.ts',
  'gen.ts',
  'hello.ts',
  'install/endpoint.ts',
  'prefetch.ts',
  'sitemap.ts',
  'stored.ts',
  'user.ts',
  'utilities.ts',
]

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return sources(p)
    return p.endsWith('.ts') && !/\.(test|isolated)\.ts$/.test(p) ? [p] : []
  })
}

function vendorImports(file: string): string[] {
  // Comments out: a commented-out example is not an import (index.ts has one).
  const text = readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const specifiers = [
    ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1])
  return specifiers.filter((s) => VENDOR.test(s))
}

describe('vendor SDKs are imported only by adapters (a ratchet)', () => {
  const files = sources(SRC).map((f) => f.slice(SRC.length))
  const importing = files
    .filter((f) => !f.startsWith('adapters/'))
    .filter((f) => vendorImports(join(SRC, f)).length > 0)
    .sort()

  test('the scan sees the tree (it is looking at something)', () => {
    expect(files.length).toBeGreaterThan(50)
    expect(importing.length).toBeGreaterThan(0)
  })

  test('no file outside adapters/ newly imports a vendor SDK', () => {
    expect(importing.filter((f) => !NOT_YET_PORTED.includes(f))).toEqual([])
  })

  test('the not-yet-ported list holds no file that has since been ported', () => {
    // If this fails, delete the named entries from NOT_YET_PORTED: the ratchet
    // only turns one way.
    expect(NOT_YET_PORTED.filter((f) => !importing.includes(f))).toEqual([])
  })
})
