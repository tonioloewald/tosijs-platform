/**
 * Endpoint WIRING tests (review findings F2, F5).
 *
 * The review's sharpest observation: mutation testing showed that deleting the
 * `afterWrite` call and reverting the opaque LIST status left the suite
 * *byte-identically green*. `opacity.test.ts` and `after-write.test.ts` pin the
 * extracted helpers in isolation — `opacity.test.ts` imports only `./access`, so
 * it is structurally incapable of noticing whether any endpoint calls it.
 *
 * A helper test proves the helper works. It cannot prove the endpoint uses it.
 * This file covers the second question.
 *
 * `doc.ts` / `docs.ts` are `onRequest` handlers bound to Firestore and cannot be
 * driven without an emulator, so these assert the wiring at the SOURCE level.
 * That is crude, and deliberately so: it is the cheapest thing that actually
 * fails when the wiring is removed, which is the property the previous tests
 * lacked. Replace it with a real harness when the handlers are extracted
 * (tracked as the remainder of F2).
 *
 * Run: cd functions && bun test src/collections/endpoint-wiring.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf-8')
const docTs = src('doc.ts')
const docsTs = src('docs.ts')

describe('docs.ts routes LIST denials through opaqueStatus', () => {
  test('it imports the shared helper', () => {
    expect(docsTs).toMatch(/opaqueStatus/)
  })

  test('the denial branch uses it rather than a bare 403', () => {
    // The exact regression: `res.status(403).send()` for a non-listable
    // collection, which confirmed the collection exists while /doc hid it.
    expect(docsTs).toContain('opaqueStatus(userRoles, 403)')
    expect(docsTs).not.toMatch(/res\.status\(403\)/)
  })
})

describe('doc.ts denial branches do not disclose existence', () => {
  test('the access-gate denial is privilege-gated, not a bare 403', () => {
    // Non-privileged callers must get 404 there.
    expect(docTs).toMatch(/hasPrivilegedRole\(userRoles\)/)
    expect(docTs).toMatch(/status\(404\)\.send\('not found'\)/)
  })

  test('the DELETE denial is opaque', () => {
    const del = docTs.slice(
      docTs.indexOf("case 'DELETE':"),
      docTs.indexOf("case 'POST':")
    )
    expect(del).toContain('opaqueStatus(userRoles, 403)')
  })

  test('no DENIAL response reflects the caller-supplied path back', () => {
    // Post-authorization 403s are fine (the caller already holds write access to
    // the collection), but echoing input is gratuitous. Scoped to 4xx/5xx — a
    // success body like `updated ${path}` is legitimate and must not trip this.
    const reflecting = [
      ...docTs.matchAll(/\.status\(\s*(4\d\d|5\d\d)\s*\)\s*\.send\(`[^`]*\$\{path\}[^`]*`\)/g),
    ].map((m) => m[0])
    expect(reflecting).toEqual([])
  })

  test('the two post-authorization conflicts say what happened without echoing input', () => {
    expect(docTs).toContain("send('document already exists')")
    expect(docTs).toContain("send('cannot update non-existent document')")
  })
})

describe('doc.ts fires afterWrite on every mutation path', () => {
  test('both the write and the delete branch invoke it', () => {
    const callSites = docTs.match(/config\.afterWrite\(/g) ?? []
    expect(callSites.length).toBeGreaterThanOrEqual(2)
  })

  test('each call site follows its commit, never precedes it', () => {
    // The original bug was ordering: invalidating before the write let a reader
    // repopulate the cache from pre-write data.
    const del = docTs.slice(
      docTs.indexOf("case 'DELETE':"),
      docTs.indexOf("case 'POST':")
    )
    expect(del.indexOf('ref.delete()')).toBeLessThan(del.indexOf('config.afterWrite('))

    const write = docTs.slice(docTs.indexOf("case 'POST':"))
    expect(write.indexOf('ref.set(data)')).toBeLessThan(
      write.indexOf('config.afterWrite(')
    )
  })

  test('afterWrite failures never fail the request', () => {
    // The write already succeeded; a cache-invalidation error must not turn a
    // saved document into a client-visible error.
    const warnings = docTs.match(/afterWrite failed/g) ?? []
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })
})
