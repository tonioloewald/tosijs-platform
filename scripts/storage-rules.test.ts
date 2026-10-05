/**
 * storage.rules may grant reads ONLY inside the legacy folders — the same
 * allowlist /stored uses (functions/src/legacy-storage.ts). Storage areas
 * share the bucket and are served only by /blob (0.3.0 reviews: B2, re-review
 * G2, re-review 2 B1). The live proof is verify-blob.js; this fails in
 * `bun test` if the rules regress. A rules-emulator test would be stronger
 * (board #2485).
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { LEGACY_FOLDERS } from '../functions/src/legacy-storage'

const rules = readFileSync(new URL('../storage.rules', import.meta.url), 'utf-8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n')

/** Every `match <path> { … allow read|get|list … }`, by the path's first segment. */
function readGrants(): string[] {
  const out: string[] = []
  const re = /match\s+(\/[^\s{]*(?:\{[^}]*\}[^\s{]*)*)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rules))) {
    const path = m[1]
    if (path.startsWith('/b/')) continue // the bucket wrapper
    const bodyStart = re.lastIndex
    const body = rules.slice(bodyStart, rules.indexOf('}', bodyStart))
    if (/allow\s+[^:]*\b(read|get|list)\b/.test(body)) out.push(path.split('/')[1])
  }
  return out
}

describe('storage.rules: reads are an allowlist of the legacy folders', () => {
  test('the rules parse into some read grants (the test is looking at something)', () => {
    expect(readGrants().length).toBeGreaterThan(0)
  })
  test('every read grant is inside a legacy folder — never a wildcard, never an area', () => {
    for (const first of readGrants()) {
      expect(LEGACY_FOLDERS as readonly string[]).toContain(first)
    }
  })
  test('no rule matches everything', () => {
    expect(rules).not.toMatch(/match\s+\/\{\w+=\*\*\}/)
    expect(rules).not.toMatch(/match\s+\/\{\w+\}\s*\/\s*\{\w+=\*\*\}/)
  })
})

describe('firebase.json: files served from the site origin are sandboxed by HOSTING', () => {
  // Hosting's site-wide CSP REPLACES a CSP the function sets, so the sandbox
  // for /blob and /stored must be a Hosting header rule placed AFTER the
  // site-wide one (0.3.0 re-review 2: found live, invisible via function URLs).
  const hosting = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf-8')).hosting
  const rules: Array<{ source: string; headers: Array<{ key: string; value: string }> }> = hosting.headers
  const csp = (r: { headers: Array<{ key: string; value: string }> }) =>
    r.headers.find((h) => h.key.toLowerCase() === 'content-security-policy')?.value ?? ''

  test('a rule covering /blob and /stored sets a sandbox CSP and nosniff', () => {
    const i = rules.findIndex((r) => r.source.includes('blob') && r.source.includes('stored'))
    expect(i).toBeGreaterThan(-1)
    expect(csp(rules[i])).toStartWith('sandbox;')
    expect(rules[i].headers.some((h) => h.key === 'X-Content-Type-Options' && h.value === 'nosniff')).toBe(true)
  })
  test('its CSP is exactly SANDBOX_CSP — one policy, not two drifting copies', async () => {
    const { SANDBOX_CSP } = await import('../functions/src/blob-handler')
    const i = rules.findIndex((r) => r.source.includes('blob') && r.source.includes('stored'))
    expect(csp(rules[i])).toBe(SANDBOX_CSP)
  })
  test('…and it comes after every site-wide CSP rule, so it wins', () => {
    const i = rules.findIndex((r) => r.source.includes('blob') && r.source.includes('stored'))
    const lastWide = rules.map((r, n) => (r.source === '**' && csp(r) ? n : -1)).reduce((a, b) => Math.max(a, b), -1)
    expect(i).toBeGreaterThan(lastWide)
  })
})

describe('firebase.json: the sign-in pages are served from the site domain', () => {
  // Google sign-in only works from a host's AUTHORIZED domains; a function's
  // cloudfunctions.net address is not one (found live 2026-10-05). So the
  // pages go through Hosting, which needs a rewrite per path and a header
  // rule carrying the pages' own CSP (Hosting replaces the function's).
  const hosting = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf-8')).hosting

  test('each page path is rewritten to its function, before the catch-all', async () => {
    const { PAGE_PATHS } = await import('../functions/src/page-csp')
    const sources = hosting.rewrites.map((r: { source: string }) => r.source)
    const catchAll = sources.indexOf('**')
    for (const name of PAGE_PATHS) {
      const i = sources.indexOf(`/${name}`)
      expect(i).toBeGreaterThan(-1)
      expect(i).toBeLessThan(catchAll)
      expect(hosting.rewrites[i].function).toBe(name)
    }
  })

  test('a header rule gives exactly those paths PAGE_CSP, after the site-wide rule', async () => {
    const { PAGE_CSP, PAGE_PATHS } = await import('../functions/src/page-csp')
    const rules: Array<{ source: string; headers: Array<{ key: string; value: string }> }> = hosting.headers
    const i = rules.findIndex((r) => PAGE_PATHS.every((p: string) => r.source.includes(p)))
    expect(i).toBeGreaterThan(rules.findIndex((r) => r.source === '**'))
    expect(rules[i].headers.find((h) => h.key === 'Content-Security-Policy')?.value).toBe(PAGE_CSP)
  })
})

