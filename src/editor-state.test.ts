/**
 * The editor's state object must carry every field the editor writes to.
 *
 * ## The trap
 *
 * tosijs does not silently ignore an assignment to a key that is not on the
 * object — it THROWS:
 *
 *     ;(proxy.missingKey as any).value = 'x'
 *     // TypeError: Attempted to assign to readonly property.
 *
 * `savePost` does `;(blog.editorPost.path as any).value = data.path`, and
 * `publish`/`unpublish` do `blog.editorPost.date!.value = …` — the `!` there was
 * already admitting the field might be absent. So a single missing key does not
 * degrade gracefully: it throws part-way through `savePost`, BEFORE the network
 * call, and the author sees a save that quietly does nothing.
 *
 * This is reachable with real data. `editPost` used to seed the editor with
 * `{...post}` straight from the store, and stored posts predate several of these
 * fields — one production post has no `date` key at all, and 748 of 849 carry
 * legacy Appwrite fields rather than the current shape. Seeding now spreads
 * `emptyPost` first so the shape is complete regardless of what was stored.
 *
 * These tests pin the invariant and the reason, so the `...emptyPost` in
 * `editPost` cannot be "tidied away" as redundant.
 *
 * Run: bun test src/editor-state.test.ts
 */
import { test, expect, describe } from 'bun:test'
import { tosi } from 'tosijs'

/** Every field the editor binds to or assigns. Keep in sync with blog.ts. */
const EDITOR_FIELDS = ['title', 'path', 'content', 'date', 'summary'] as const

describe('tosijs assignment to a missing key', () => {
  test('THROWS rather than no-opping — the reason this file exists', () => {
    const { st } = tosi({ st: { post: { title: 't' } } as never })
    expect(() => {
      ;((st as never as { post: { path: { value: string } } }).post.path).value =
        'x'
    }).toThrow(/readonly/i)
  })

  test('succeeds when the key exists', () => {
    const { st } = tosi({ st: { post: { title: 't', path: '' } } as never })
    expect(() => {
      ;((st as never as { post: { path: { value: string } } }).post.path).value =
        'hello'
    }).not.toThrow()
  })
})

describe('seeding the editor from a stored post', () => {
  // Mirrors blog.ts's `emptyPost` shape.
  const emptyPost = {
    title: '',
    path: '',
    content: '',
    format: 'markdown',
    date: '',
    keywords: [] as string[],
    summary: '',
    author: '',
  }

  // A real shape from production: no `date`, no `summary`, plus legacy cruft.
  const legacyPost = {
    title: 'An old post',
    content: 'body',
    path: 'an-old-post',
    $id: 'appwrite-leftover',
  }

  test('seeding WITHOUT emptyPost leaves fields the editor assigns missing', () => {
    const seeded = { ...legacyPost }
    const missing = EDITOR_FIELDS.filter((f) => !(f in seeded))
    // Exactly the bug: `date` and `summary` absent, so assigning either throws.
    expect(missing).toEqual(['date', 'summary'])
  })

  test('seeding WITH emptyPost first yields every field the editor needs', () => {
    const seeded = { ...emptyPost, ...legacyPost }
    for (const field of EDITOR_FIELDS) {
      expect(field in seeded).toBe(true)
    }
  })

  test('the stored values still win over the empty defaults', () => {
    const seeded = { ...emptyPost, ...legacyPost }
    expect(seeded.title).toBe('An old post')
    expect(seeded.path).toBe('an-old-post')
    // …and the absent ones fall back rather than being undefined.
    expect(seeded.date).toBe('')
    expect(seeded.summary).toBe('')
  })

  test('assignment to every editor field works on a seeded post', () => {
    const { st } = tosi({ st: { post: { ...emptyPost, ...legacyPost } } as never })
    const post = (st as never as Record<string, Record<string, { value: unknown }>>)
      .post
    for (const field of EDITOR_FIELDS) {
      expect(() => {
        post[field].value = 'x'
      }).not.toThrow()
    }
  })
})
