/**
 * Filter-before-limit (decision: Tonio, 2026-09-06).
 *
 * `getRecords` used to apply `.limit(n)` and let the caller drop rows
 * afterwards, so a request for 10 published posts could return 3 while 50
 * existed — the limit was consumed by rows the caller was never allowed to see.
 * Asking for n and getting fewer, with more available, is a wrong answer.
 *
 * `getRecords` needs Firestore, so these test the two properties that were
 * wrong, at the level they can be tested without an emulator: the paging
 * arithmetic, and the projection ordering. The end-to-end behaviour is covered
 * by the integration suite.
 *
 * Run: cd functions && bun test src/collections/filter-before-limit.test.ts
 */
import { describe, test, expect } from 'bun:test'

/** The shape of the loop in getRecords, over a fake collection. */
async function pageUntilSatisfied(
  corpus: Record<string, unknown>[],
  limit: number,
  visible: (r: Record<string, unknown>) => boolean,
  pageSize = 50,
  maxScan = 2000
) {
  const kept: Record<string, unknown>[] = []
  let i = 0
  let scanned = 0
  while (kept.length < limit && scanned < maxScan && i < corpus.length) {
    const page = corpus.slice(i, i + pageSize)
    i += page.length
    scanned += page.length
    for (const rec of page) {
      if (visible(rec)) {
        kept.push(rec)
        if (kept.length === limit) break
      }
    }
    if (page.length < pageSize) break
  }
  return { kept, scanned }
}

// 100 posts, only every 10th published — the selective-predicate case.
const corpus = Array.from({ length: 100 }, (_, n) => ({
  n,
  date: n % 10 === 0 ? '2026-01-01T00:00:00.000Z' : '',
}))
const isPub = (r: Record<string, unknown>) => String(r.date ?? '').trim() !== ''

describe('a request for n visible rows returns n', () => {
  test('THE BUG: limit-then-filter would have returned 1 of 10', () => {
    // Old behaviour, reproduced: take 10, then filter.
    const old = corpus.slice(0, 10).filter(isPub)
    expect(old.length).toBe(1) // ← what production did
  })

  test('filter-then-limit returns all 10', async () => {
    const { kept } = await pageUntilSatisfied(corpus, 10, isPub)
    expect(kept.length).toBe(10)
    expect(kept.every(isPub)).toBe(true)
  })

  test('returns everything available when fewer than n exist', async () => {
    const scarce = corpus.slice(0, 25) // only 3 published
    const { kept } = await pageUntilSatisfied(scarce, 10, isPub)
    expect(kept.length).toBe(3)
  })

  test('stops as soon as it has enough — no full scan for a common predicate', async () => {
    const { kept, scanned } = await pageUntilSatisfied(corpus, 2, isPub, 50)
    expect(kept.length).toBe(2)
    expect(scanned).toBeLessThanOrEqual(50) // one page sufficed
  })

  test('an empty collection yields nothing rather than looping', async () => {
    const { kept } = await pageUntilSatisfied([], 10, isPub)
    expect(kept).toEqual([])
  })

  test('the scan bound stops an unsatisfiable predicate', async () => {
    const huge = Array.from({ length: 5000 }, (_, n) => ({ n, date: '' }))
    const { kept, scanned } = await pageUntilSatisfied(huge, 10, isPub, 50, 2000)
    expect(kept.length).toBe(0)
    expect(scanned).toBeLessThanOrEqual(2000) // bounded, not unbounded
  })
})

describe('projection happens AFTER filtering', () => {
  // The second bug in the same function: `.select(...fields)` ran before the
  // predicate, so a projection that omitted the field the predicate reads made
  // every row look invisible.
  const project = (rec: Record<string, unknown>, fields: string[]) => {
    const out: Record<string, unknown> = { _path: rec._path }
    for (const f of fields) if (f in rec) out[f] = rec[f]
    return out
  }

  test('THE BUG: projecting away `date` before filtering hides everything', () => {
    const projectedFirst = corpus.map((r) => project(r, ['n'])) // no `date`
    expect(projectedFirst.filter(isPub).length).toBe(0) // ← all posts vanish
  })

  test('filtering on the full document, then projecting, keeps the right rows', async () => {
    const { kept } = await pageUntilSatisfied(corpus, 5, isPub)
    const out = kept.map((r) => project(r, ['n']))
    expect(out.length).toBe(5)
    expect(out.every((r) => !('date' in r))).toBe(true) // projection applied
  })

  test('_path survives projection — clients rely on it', async () => {
    const { kept } = await pageUntilSatisfied(
      corpus.map((r) => ({ ...r, _path: `post/${r.n}` })),
      3,
      isPub
    )
    const out = kept.map((r) => project(r, ['n']))
    expect(out.every((r) => typeof r._path === 'string')).toBe(true)
  })
})
