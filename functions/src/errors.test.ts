/**
 * The one error shape (#20).
 *
 * Run: cd functions && bun test src/errors.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

import { fail, notFound, ERROR_CODES } from './errors'

const spy = () => {
  const sent: {
    status?: number
    body?: unknown
    headers: Record<string, string>
  } = { headers: {} }
  const res = {
    set(k: string, v: string) {
      sent.headers[k] = v
      return res
    },
    status(s: number) {
      sent.status = s
      return res
    },
    json(b: unknown) {
      sent.body = b
      return res
    },
  }
  return { res: res as never, sent }
}

describe('the shape', () => {
  test('a code and prose, separately', () => {
    const { res, sent } = spy()
    fail(res, 400, 'schema', 'schema validation failed', { details: [1] })
    expect(sent.status).toBe(400)
    expect(sent.body).toEqual({
      error: 'schema',
      message: 'schema validation failed',
      details: [1],
    })
  })

  test('`error` is the CODE, never the prose', () => {
    // The old JSON shape put the sentence in `error`, which is what forced a
    // client to match on wording in the first place.
    const { res, sent } = spy()
    fail(res, 403, 'exists', 'document already exists')
    expect((sent.body as { error: string }).error).toBe('exists')
    expect((sent.body as { error: string }).error).not.toContain(' ')
  })

  test('an opaque denial carries no detail at all', () => {
    // Every branch reaching it must be indistinguishable from every other, or
    // the body becomes the oracle the status code refuses to be.
    const { res, sent } = spy()
    notFound(res)
    expect(sent.status).toBe(404)
    expect(sent.body).toEqual({ error: 'not-found', message: 'not found' })
  })
})

describe('the code set is closed and machine-friendly', () => {
  test('every code is a stable slug', () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[a-z][a-z-]*[a-z]$/)
    }
  })

  test('no duplicates', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})

describe('the platform routes actually use it', () => {
  // A helper nobody calls is the same as no helper. These are the routes a
  // consumer talks to; the older loewald.com surface (gen/sitemap/prefetch/
  // esm/stored) is deliberately not converted — it is being extracted, and
  // changing it risks a live site for no consumer benefit.
  const PLATFORM = [
    'doc.ts',
    'docs.ts',
    'claim.ts',
    'install/endpoint.ts',
    'auth/endpoint.ts',
    'auth/authorize-endpoint.ts',
  ]

  for (const file of PLATFORM) {
    test(`${file} builds no error body by hand`, () => {
      const source = readFileSync(join(__dirname, file), 'utf-8')
      // `.status(4xx|5xx).send(...)` is the old shape; `.json({status:'refused'})`
      // was the other one.
      expect(source).not.toMatch(/\.status\(\s*[45]\d\d\s*\)\s*\.send\(/)
      expect(source).not.toMatch(/status:\s*'refused'/)
    })
  }
})

describe('errors are never cached by a shared CDN (#27)', () => {
  // Behind Firebase Hosting a response with no Cache-Control gets max-age=600,
  // keyed on the URL alone — so one caller's 401 was served to everyone.
  test('fail() sets no-store', () => {
    const { res, sent } = spy()
    fail(res, 401, 'unauthenticated', 'no')
    expect(sent.headers['Cache-Control']).toBe('no-store')
  })

  test('notFound() sets no-store', () => {
    const { res, sent } = spy()
    notFound(res)
    expect(sent.headers['Cache-Control']).toBe('no-store')
  })
})

describe('the documented error codes ARE the code set (0.2.0 review, M3)', () => {
  // BETA.md's Errors table is the consumer contract; ERROR_CODES is what the
  // code can send. They must name the same set, so neither can drift.
  test('BETA.md lists exactly ERROR_CODES', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const doc = readFileSync(join(__dirname, '..', '..', 'BETA.md'), 'utf8')
    const section = doc.slice(doc.indexOf('### Errors'), doc.indexOf('## 6.'))
    const documented = [...section.matchAll(/^\| `([a-z-]+)` \|/gm)]
      .map((m) => m[1])
      .filter((c) => c !== 'error') // the header row
    expect([...documented].sort()).toEqual([...ERROR_CODES].sort())
  })
})
