import { describe, expect, test } from 'bun:test'
import { documentPath } from './access'

describe('documentPath: _path names the document, not the lookup', () => {
  test('a slug lookup reports the id (the blog editor saves to _path)', () => {
    expect(documentPath('post/path=old-slug', 'rd7xk3qqp020')).toBe('post/rd7xk3qqp020')
  })
  test('an id path is unchanged', () => {
    expect(documentPath('post/rd7xk3qqp020', 'rd7xk3qqp020')).toBe('post/rd7xk3qqp020')
    expect(documentPath('a/x/b/y', 'y')).toBe('a/x/b/y')
  })
  test('nested: only the final specifier is replaced', () => {
    expect(documentPath('a/x/b/name=n', 'id9')).toBe('a/x/b/id9')
  })
  test('a lookup earlier in the path is left as asked', () => {
    expect(documentPath('a/k=v/b/name=n', 'id9')).toBe('a/k=v/b/name=n')
  })
})
