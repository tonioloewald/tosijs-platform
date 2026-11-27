import { describe, test, expect } from 'bun:test'
import {
  MOVES,
  atLeast,
  movedPageData,
  movedPageFields,
  movedPath,
  planIsComplete,
  planMove,
  stable,
  transformFor,
} from './blog-collections-lib.js'

const str = (stringValue: string) => ({ stringValue })
const doc = (fields: Record<string, unknown>, updateTime = '2026-11-27T00:00:00Z') => ({ fields, updateTime })

describe('movedPath', () => {
  test('renames the moved collections and nothing else', () => {
    expect(movedPath('post/path=[3]')).toBe('blog:post/path=[3]')
    expect(movedPath('post/abc')).toBe('blog:post/abc')
    expect(movedPath('page/path=blog')).toBe('blog:page/path=blog')
    expect(movedPath('config/app')).toBe('config/app')
    expect(movedPath('blog:post/abc')).toBe('blog:post/abc')
    expect(movedPath('posts/abc')).toBe('posts/abc')
    expect(movedPath(undefined)).toBeUndefined()
  })
  test('moves exactly post and page', () => {
    expect(MOVES).toEqual([
      { from: 'post', to: 'blog:post' },
      { from: 'page', to: 'blog:page' },
    ])
  })
})

describe('movedPageFields', () => {
  // Production's blog page, as its backup has it.
  const blogPage = {
    path: str('blog'),
    prefetch: {
      arrayValue: {
        values: [{ mapValue: { fields: { regexp: str('^\\/(([\\w\\d]+\\/)*)([\\w-]+)\\/?$'), path: str('post/path=[3]') } } }],
      },
    },
  }

  test("the blog page's prefetch names blog:post, and nothing else changes", () => {
    const out = movedPageFields(blogPage)
    expect(out.prefetch.arrayValue.values[0].mapValue.fields.path).toEqual(str('blog:post/path=[3]'))
    expect(out.prefetch.arrayValue.values[0].mapValue.fields.regexp).toEqual(blogPage.prefetch.arrayValue.values[0].mapValue.fields.regexp)
    expect(out.path).toBe(blogPage.path)
    // The input is not modified.
    expect(blogPage.prefetch.arrayValue.values[0].mapValue.fields.path).toEqual(str('post/path=[3]'))
  })

  test('a page without prefetch, or naming nothing moved, is returned as it is', () => {
    const about = { path: str('about') }
    expect(movedPageFields(about)).toBe(about)
    const other = { prefetch: { arrayValue: { values: [{ mapValue: { fields: { path: str('config/app') } } }] } } }
    expect(movedPageFields(other)).toBe(other)
  })

  test('only pages are rewritten', () => {
    expect(transformFor('post')(blogPage)).toBe(blogPage)
    expect(transformFor('page')(blogPage)).not.toBe(blogPage)
  })
})

test('movedPageData: the same rewrite on a decoded page', () => {
  const page = { path: 'blog', prefetch: [{ regexp: 'x', path: 'post/path=[3]' }] }
  expect(movedPageData(page)).toEqual({ path: 'blog', prefetch: [{ regexp: 'x', path: 'blog:post/path=[3]' }] })
  expect(page.prefetch[0].path).toBe('post/path=[3]')
  const about = { path: 'about' }
  expect(movedPageData(about)).toBe(about)
})

describe('planMove', () => {
  const at = (iso: string, extra: Record<string, unknown> = {}) => ({ _modified: str(iso), ...extra })

  test('a first run creates everything', () => {
    const source = new Map([
      ['a', doc(at('2026-01-01', { title: str('A') }))],
      ['b', doc(at('2026-01-02', { title: str('B') }))],
    ])
    const plan = planMove(source, new Map())
    expect(plan.create.map((c) => c.id)).toEqual(['a', 'b'])
    expect(plan.create[0].fields).toEqual(source.get('a')!.fields)
    expect(planIsComplete(plan)).toBe(false)
  })

  test('a second run has nothing to do, whatever the key order', () => {
    const source = new Map([['a', doc({ title: str('A'), _modified: str('2026-01-01') })]])
    const target = new Map([['a', doc({ _modified: str('2026-01-01'), title: str('A') })]])
    const plan = planMove(source, target)
    expect(plan.unchanged).toEqual(['a'])
    expect(planIsComplete(plan)).toBe(true)
  })

  test('a post edited in the OLD collection after the copy is copied again', () => {
    const source = new Map([['a', doc(at('2026-11-28', { title: str('edited') }))]])
    const target = new Map([['a', doc(at('2026-11-27', { title: str('A') }), 'T1')]])
    const plan = planMove(source, target)
    expect(plan.update).toEqual([{ id: 'a', fields: source.get('a')!.fields, updateTime: 'T1' }])
  })

  test('a post edited in the NEW collection after the move is kept', () => {
    const source = new Map([['a', doc(at('2026-11-27', { title: str('A') }))]])
    const target = new Map([['a', doc(at('2026-11-28', { title: str('edited after the move') }))]])
    const plan = planMove(source, target)
    expect(plan.kept).toEqual(['a'])
    expect(planIsComplete(plan)).toBe(true)
  })

  test('different with the same modification time is a conflict, left alone', () => {
    const source = new Map([['a', doc(at('2026-11-27', { title: str('A') }))]])
    const target = new Map([['a', doc(at('2026-11-27', { title: str('B') }))]])
    const plan = planMove(source, target)
    expect(plan.conflict).toEqual(['a'])
    expect(plan.update).toEqual([])
    expect(planIsComplete(plan)).toBe(false)
  })

  test('a post written only in the new collection is left alone, and nothing is ever deleted', () => {
    const plan = planMove(new Map(), new Map([['new', doc(at('2026-11-29'))]]))
    expect(plan.onlyInTarget).toEqual(['new'])
    expect(Object.keys(plan)).not.toContain('delete')
  })

  test('the page rewrite is part of the comparison, so a moved blog page is unchanged on a re-run', () => {
    const fields = { _modified: str('2026-01-01'), prefetch: { arrayValue: { values: [{ mapValue: { fields: { path: str('post/path=[3]') } } }] } } }
    const first = planMove(new Map([['blog', doc(fields)]]), new Map(), transformFor('page'))
    const copied = first.create[0].fields
    const again = planMove(new Map([['blog', doc(fields)]]), new Map([['blog', doc(copied)]]), transformFor('page'))
    expect(again.unchanged).toEqual(['blog'])
  })
})

test('stable compares by content', () => {
  expect(stable({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(stable({ b: [1, { d: 3, c: 2 }], a: 1 }))
  expect(stable({ a: 1 })).not.toBe(stable({ a: '1' }))
})

test('atLeast', () => {
  expect(atLeast('1.1.0', '1.1.0')).toBe(true)
  expect(atLeast('1.2.0', '1.1.0')).toBe(true)
  expect(atLeast('2.0.0', '1.1.0')).toBe(true)
  expect(atLeast('1.0.9', '1.1.0')).toBe(false)
  expect(atLeast(undefined, '1.1.0')).toBe(false)
  expect(atLeast('1.1', '1.1.0')).toBe(false)
})
