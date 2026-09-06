import { s, type Infer } from 'tosijs-schema'

export const PostSchema = s.object({
  title: s.string.title('Title').describe('Post title'),
  content: s.string.title('Content').describe('Post content (HTML or Markdown)'),
  path: s.string.optional.title('URL Path').describe('URL-friendly path (auto-generated from title if not provided)'),
  date: s.string.optional.title('Publish Date').describe('ISO date string when published'),
  summary: s.string.optional.title('Summary').describe('Short summary for previews'),
  keywords: s.array(s.string).optional.title('Keywords').describe('SEO keywords'),
  imageUrl: s.string.optional.title('Image URL').describe('Featured image URL'),
  author: s.string.optional.title('Author').describe('Author name'),
  // authoring format the editor round-trips (markdown|html)
  format: s.string.optional.title('Format').describe('markdown or html'),
  _created: s.string.optional,
  _modified: s.string.optional,
})

export type Post = Infer<typeof PostSchema>

export const emptyPost: Post = {
  title: '',
  content: '',
}

/**
 * The single definition of "published", shared by the client and the server.
 *
 * A post is published iff it carries a NON-EMPTY date. This exists because the
 * two halves disagreed and the disagreement was a live data leak: the client's
 * `unpublish()` writes `date = ''`, while the server's list guard tested
 * `date !== undefined` — and `'' !== undefined` is true, so every post
 * unpublished through the UI sailed straight past the guard meant to hide it.
 * 57 of 849 production posts were in that state.
 *
 * Three things mean "empty" in this codebase and code keeps picking one:
 * `undefined` (field absent), `''` (what `unpublish()` writes), and a *boxed
 * tosijs proxy scalar* — which is an object, and therefore truthy even when the
 * underlying string is empty. `String(value ?? '').trim()` collapses all three,
 * which is why the coercion is here rather than at each call site.
 *
 * Deliberately NOT a parseability check: a mistyped date should render oddly
 * (see `formatBlogDate`), not silently unpublish a live post. Visibility and
 * display are different questions.
 */
export const UNPUBLISHED_DATE = ''

export function isPublished(
  post: { date?: unknown } | null | undefined
): boolean {
  if (post === null || post === undefined) return false
  return String(post.date ?? '').trim() !== ''
}
