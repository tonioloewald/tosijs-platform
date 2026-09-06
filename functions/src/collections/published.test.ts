/**
 * The shared definition of "published" (2026-09-06).
 *
 * These exist because the client and server disagreed and the disagreement was
 * a live data leak: `unpublish()` writes `date = ''`, while the server's list
 * guard tested `date !== undefined` — and `'' !== undefined` is true, so all 57
 * unpublished posts in production were being served to anonymous callers.
 *
 * The shapes below are the ones that ACTUALLY occur in the production corpus
 * (measured from a backup of 849 posts): 791 ISO datetimes, 57 empty strings,
 * 1 missing field.
 *
 * Run: cd functions && bun test src/collections/published.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { isPublished, UNPUBLISHED_DATE } from '../../shared/post'

describe('the three "empty" shapes that actually occur', () => {
  test('THE LEAK: an empty-string date is NOT published (57 production posts)', () => {
    // `'' !== undefined` was true, which is exactly how these got served.
    expect(isPublished({ date: '' })).toBe(false)
  })

  test('a missing date field is not published (1 production post)', () => {
    expect(isPublished({})).toBe(false)
    expect(isPublished({ date: undefined })).toBe(false)
  })

  test('an ISO datetime is published (791 production posts)', () => {
    expect(isPublished({ date: '2026-09-06T12:00:00.000Z' })).toBe(true)
  })
})

describe('the sentinel and the guard agree', () => {
  test('what unpublish() writes is what the guard rejects', () => {
    // The drift that caused the leak, pinned: if either side changes alone,
    // this fails.
    expect(isPublished({ date: UNPUBLISHED_DATE })).toBe(false)
  })
})

describe('coercion cases the codebase keeps tripping over', () => {
  test('whitespace-only is not published', () => {
    expect(isPublished({ date: '   ' })).toBe(false)
  })

  test('a BOXED proxy scalar wrapping an empty string is not published', () => {
    // A live tosijs proxy scalar is an OBJECT — truthy even when the underlying
    // string is empty — which is why `!!ref.date` was wrong on the client.
    const boxedEmpty = { toString: () => '', valueOf: () => '' }
    expect(isPublished({ date: boxedEmpty })).toBe(false)
  })

  test('a boxed proxy wrapping a real date IS published', () => {
    const boxedDate = {
      toString: () => '2026-09-06T12:00:00.000Z',
      valueOf: () => '2026-09-06T12:00:00.000Z',
    }
    expect(isPublished({ date: boxedDate })).toBe(true)
  })

  test('null/undefined posts are not published rather than throwing', () => {
    expect(isPublished(null)).toBe(false)
    expect(isPublished(undefined)).toBe(false)
  })
})

describe('deliberately NOT a parseability check', () => {
  test('a mistyped date stays published rather than silently vanishing', () => {
    // Visibility and display are different questions: formatBlogDate renders
    // this as "Not Published", but the post must not disappear from the site
    // because someone fat-fingered a date.
    expect(isPublished({ date: 'next tuesday' })).toBe(true)
  })
})
