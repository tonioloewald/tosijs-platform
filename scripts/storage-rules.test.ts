/**
 * storage.rules must keep storage areas (/blob) out of direct client reach
 * (0.3.0 review B2, re-review G2). The live proof is verify-blob.js; this is
 * the cheap guard that fails in `bun test` if the rules regress. A rules
 * emulator test would be stronger (tracked in TODO.md).
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'

const rules = readFileSync(new URL('../storage.rules', import.meta.url), 'utf-8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n')
const block = (header: string) => {
  const i = rules.indexOf(header)
  if (i < 0) return ''
  const body = rules.indexOf('{', i + header.length) // the block's own brace, past the path's
  return rules.slice(body, rules.indexOf('}', body))
}

describe('storage.rules keeps storage areas private', () => {
  test('the public-read default excludes a namespaced first segment', () => {
    expect(block('match /{first}/{rest=**}')).toContain("allow read: if !first.matches('.*:.*')")
  })
  test('top-level files: get only — the root is never listable (it is recursive)', () => {
    const b = block('match /{file}')
    expect(b).toContain("allow get: if !file.matches('.*:.*')")
    expect(b).not.toMatch(/allow (read|list)/)
  })
  test('no rule grants an unconditional read on everything', () => {
    expect(rules).not.toMatch(/match \/\{\w+=\*\*\}\s*\{\s*allow read: if true/)
  })
})
