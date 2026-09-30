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
    // Comments out: a commented-out example is not an endpoint.
    const text = readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    return [...text.matchAll(/\bonRequest\(\s*([^,)]*(?:\{[^}]*\})?)/g)].map((m) => ({ file: file.slice(SRC.length), opts: m[1] }))
  })

  test('the scan finds the endpoints (it is looking at something)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(15)
  })

  test('each passes PUBLIC_ENDPOINT (directly or spread)', () => {
    const missing = calls.filter((c) => !/PUBLIC_ENDPOINT/.test(c.opts))
    expect(missing).toEqual([])
  })
})
