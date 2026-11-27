import { describe, test, expect } from 'bun:test'
import { isInvalidatedDep } from './rules'

describe('isInvalidatedDep — what a stored render value may depend on', () => {
  test('top-level documents, lookups and lists of hooked collections; other computed values', () => {
    for (const d of ['doc:blog:post/abc', 'doc:blog:post/path=x', 'doc:blog:page/path=blog', 'doc:config/app', 'list:blog:post', 'list:blog:page', 'computed:r2:blog-index']) {
      expect(isInvalidatedDep(d)).toBe(true)
    }
  })
  test('not other collections, sub-collections, or anything unrecognised', () => {
    for (const d of ['doc:module/x', 'list:module', 'doc:blog:post/x/comment/y', 'doc:virta:post/x', 'list:blog:post/x', 'doc:blog:post', 'weird']) {
      expect(isInvalidatedDep(d)).toBe(false)
    }
  })
  test('not the retired bare post and page (D28): nothing writes them, so nothing would invalidate', () => {
    for (const d of ['doc:post/abc', 'doc:post/path=x', 'doc:page/path=blog', 'list:post', 'list:page']) {
      expect(isInvalidatedDep(d)).toBe(false)
    }
  })
})
