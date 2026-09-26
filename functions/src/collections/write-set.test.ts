/**
 * The write-set gate (#15).
 *
 * Everything here runs before any I/O, so it is about what a commit must
 * satisfy to be attemptable at all.
 *
 * Run: cd functions && bun test src/collections/write-set.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

import { validateWriteSet, byCollection, MAX_WRITES } from './write-set'

const w = (p: string, over: Record<string, unknown> = {}) => ({
  p,
  data: { title: 'x' },
  ...over,
})
const problems = (r: ReturnType<typeof validateWriteSet>) =>
  (r as { problems: string[] }).problems.join('\n')

describe('a well-formed commit', () => {
  test('is accepted, and an unnamed method stays unnamed — it means UPSERT', () => {
    // Resolved at commit from the document's existence, so a first push
    // creates and a retry is a free no-op. Defaulting it to PUT here would
    // make every create fail with "cannot update non-existent document",
    // which is exactly what it did before this was fixed.
    const r = validateWriteSet({ writes: [w('virta:event/a'), w('virta:event/b')] })
    expect(r.status).toBe('ok')
    expect((r as { writes: Array<{ method?: string }> }).writes.map((x) => x.method))
      .toEqual([undefined, undefined])
  })

  test('a named method survives, so the strict guards stay available', () => {
    const r = validateWriteSet({ writes: [w('c/d', { method: 'POST' })] })
    expect((r as { writes: Array<{ method?: string }> }).writes[0].method).toBe('POST')
  })

  test('a mixed-collection commit is fine', () => {
    expect(
      validateWriteSet({ writes: [w('virta:event/a'), w('virta:task/b')] }).status
    ).toBe('ok')
  })
})

describe('what it refuses', () => {
  test('an empty or absent set', () => {
    expect(problems(validateWriteSet({}))).toContain('expected { writes:')
    expect(problems(validateWriteSet({ writes: [] }))).toContain('is empty')
  })

  test('more than the cap', () => {
    const many = Array.from({ length: MAX_WRITES + 1 }, (_, i) => w(`c/d${i}`))
    expect(problems(validateWriteSet({ writes: many }))).toContain(
      `the limit is ${MAX_WRITES}`
    )
  })

  test('the SAME document twice in one commit', () => {
    // Both cannot be judged against "the document as it exists": the second
    // would be evaluated against state the first has not written, so its
    // existence guard and no-op check answer about the wrong document.
    expect(
      problems(validateWriteSet({ writes: [w('virta:event/a'), w('virta:event/a')] }))
    ).toContain('appears twice')
  })

  test('a collection path where a document path is required', () => {
    expect(problems(validateWriteSet({ writes: [w('virta:event')] }))).toContain(
      'is not a document path'
    )
  })

  test('DELETE — single-document only, deliberately', () => {
    // A mixed commit of writes and deletes has a real ordering question in it
    // (does deleting a document another write creates win?), and guessing an
    // answer is worse than refusing one.
    expect(
      problems(validateWriteSet({ writes: [w('c/d', { method: 'DELETE' })] }))
    ).toContain('DELETE is single-document only')
  })

  test('a missing path or body', () => {
    expect(problems(validateWriteSet({ writes: [{ data: {} }] }))).toContain('.p: required')
    expect(problems(validateWriteSet({ writes: [{ p: 'c/d' }] }))).toContain(
      '.data: must be an object'
    )
  })

  test('every problem is reported, not just the first', () => {
    const r = validateWriteSet({ writes: [{ data: {} }, w('c'), w('c/d', { method: 'NOPE' })] })
    expect((r as { problems: string[] }).problems.length).toBe(3)
  })
})

describe('grouping for contiguous sequences', () => {
  test('order within a collection is preserved', () => {
    const writes = (validateWriteSet({
      writes: [w('a:x/1'), w('b:y/1'), w('a:x/2'), w('a:x/3')],
    }) as { writes: Array<{ p: string }> }).writes
    const groups = byCollection(writes as never, (p) => p.split('/')[0])
    expect(groups.get('a:x')?.map((x) => x.p)).toEqual(['a:x/1', 'a:x/2', 'a:x/3'])
    expect(groups.get('b:y')?.map((x) => x.p)).toEqual(['b:y/1'])
  })
})

describe('uniqueness WITHIN one batch (0.2.0 re-review, M1)', () => {
  // A transaction cannot see its own pending writes, so the store-side check
  // let two same-value writes in one batch both commit.
  test('a second write claiming the same value in the same collection is caught', async () => {
    const { BatchUniqueClaims } = await import('./write-set')
    const c = new BatchUniqueClaims()
    expect(c.claim('post/a', ['title', 'path'], { title: 'A', path: 'x' })).toBeNull()
    expect(c.claim('post/b', ['title', 'path'], { title: 'B', path: 'x' })).toBe('path')
  })

  test('different collections, and different sub-collection parents, do not collide', async () => {
    const { BatchUniqueClaims } = await import('./write-set')
    const c = new BatchUniqueClaims()
    expect(c.claim('post/a', ['path'], { path: 'x' })).toBeNull()
    expect(c.claim('page/a', ['path'], { path: 'x' })).toBeNull()
    expect(c.claim('post/a/comment/1', ['slug'], { slug: 's' })).toBeNull()
    expect(c.claim('post/b/comment/1', ['slug'], { slug: 's' })).toBeNull()
  })

  test('the string "1" and the number 1 are different values', async () => {
    const { BatchUniqueClaims } = await import('./write-set')
    const c = new BatchUniqueClaims()
    expect(c.claim('m/a', ['n'], { n: '1' })).toBeNull()
    expect(c.claim('m/b', ['n'], { n: 1 })).toBeNull()
  })

  test('/docs refuses the repeat inside the transaction — nothing is written', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const docs = readFileSync(join(__dirname, '..', 'docs.ts'), 'utf8')
    const phase1 = docs.slice(docs.indexOf('PHASE 1'), docs.indexOf('PHASE 2'))
    expect(phase1).toContain('new BatchUniqueClaims()')
    expect(phase1).toMatch(/claims\.claim\([\s\S]*?reason: 'unique'/)
  })
})
