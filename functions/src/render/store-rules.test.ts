import { describe, test, expect } from 'bun:test'
import { isInvalidatedDep } from './rules'

describe('isInvalidatedDep — what a stored render value may depend on', () => {
  test('top-level documents, lookups and lists of hooked collections; other computed values', () => {
    for (const d of ['doc:post/abc', 'doc:post/path=x', 'doc:page/path=blog', 'doc:config/app', 'list:post', 'list:page', 'computed:r2:blog-index']) {
      expect(isInvalidatedDep(d)).toBe(true)
    }
  })
  test('not other collections, sub-collections, or anything unrecognised', () => {
    for (const d of ['doc:module/x', 'list:module', 'doc:post/x/comment/y', 'doc:virta:post/x', 'list:post/x', 'doc:post', 'weird']) {
      expect(isInvalidatedDep(d)).toBe(false)
    }
  })
})
