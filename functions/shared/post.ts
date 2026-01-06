import { s, type Infer } from 'tosijs-schema'

export const PostSchema = s.object({
  title: s.string.title('Title').describe('Post title'),
  content: s.string.title('Content').describe('Post content (HTML or Markdown)'),
  path: s.string.optional.title('URL Path').describe('URL-friendly path (auto-generated from title if not provided)'),
  date: s.string.optional.title('Publish Date').describe('ISO date string when published'),
  summary: s.string.optional.title('Summary').describe('Short summary for previews'),
  keywords: s.string.optional.title('Keywords').describe('SEO keywords'),
  imageUrl: s.string.optional.title('Image URL').describe('Featured image URL'),
  author: s.string.optional.title('Author').describe('Author name'),
  _created: s.string.optional,
  _modified: s.string.optional,
})

export type Post = Infer<typeof PostSchema>

export const emptyPost: Post = {
  title: '',
  content: '',
}
