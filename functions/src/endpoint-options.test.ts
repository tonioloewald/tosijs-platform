/**
 * Every HTTP endpoint must be deployed publicly invocable (endpoint-options.ts),
 * or a deploy can leave it answering Google's 401 before our code runs.
 * A static scan, so a NEW endpoint that forgets fails here, not in production.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const SRC = new URL('.', import.meta.url).pathname
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return sources(p)
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : []
  })
}

describe('every HTTP endpoint is publicly invocable, declared in code', () => {
  const calls = sources(SRC).flatMap((file) => {
    const text = readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    return [...text.matchAll(/\bonRequest\(\s*([^,)]*(?:\{[^}]*\})?)/g)].map((m) => ({ file: file.slice(SRC.length), opts: m[1] }))
  })
  const indexTs = readFileSync(join(SRC, 'index.ts'), 'utf-8')
  const bound = [...indexTs.matchAll(/^export const (\w+) = firebaseEndpoint\(ENDPOINTS\.(\w+)\)/gm)].map((m) => m[1])
  const boundAs = [...indexTs.matchAll(/^export const (\w+) = firebaseEndpoint\(ENDPOINTS\.(\w+)\)/gm)]

  test('the scan finds the endpoints (it is looking at something)', () => {
    // The HTTP port (http.ts): endpoints are handlers, bound in index.ts.
    expect(bound.length).toBeGreaterThanOrEqual(15)
  })

  test('index.ts binds every endpoint in kernel.ts, each under its own name', () => {
    // The Bun server serves ENDPOINTS by name; Firebase must deploy the same set.
    const kernel = readFileSync(join(SRC, 'kernel.ts'), 'utf-8')
    const table = kernel.slice(kernel.indexOf('export const ENDPOINTS'))
    const names = [...table.matchAll(/^ {2}(\w+): \{ handler:/gm)].map((m) => m[1])
    expect(names.length).toBeGreaterThanOrEqual(15)
    expect(boundAs.map((m) => m[1]).sort()).toEqual([...names].sort())
    expect(boundAs.filter((m) => m[1] !== m[2])).toEqual([])
  })

  test('onRequest is called only by the Firebase HTTP adapter', () => {
    expect([...new Set(calls.map((c) => c.file))].sort()).toEqual(['adapters/firebase/http.ts'])
  })

  test('each passes PUBLIC_ENDPOINT (directly or spread)', () => {
    const missing = calls.filter((c) => !/PUBLIC_ENDPOINT/.test(c.opts))
    expect(missing).toEqual([])
  })

  test('every function the deploy checks probes is exported from index.ts', () => {
    // A handler that is written but never bound does not deploy at all.
    const lib = readFileSync(join(SRC, '..', '..', 'scripts', 'sandbox-lib.js'), 'utf-8')
    const listed = [...lib.matchAll(/(?:PLATFORM|SITE)_FUNCTIONS = \[([\s\S]*?)\]/g)].flatMap((m) =>
      [...m[1].matchAll(/'(\w+)'/g)].map((n) => n[1])
    )
    expect(listed.length).toBeGreaterThanOrEqual(15)
    const exported = new Set([...bound, ...[...indexTs.matchAll(/^export \{ (\w+) \}/gm)].map((m) => m[1])])
    expect(listed.filter((n) => !exported.has(n))).toEqual([])
  })
})
