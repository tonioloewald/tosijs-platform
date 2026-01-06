import { s, type Infer } from 'tosijs-schema'

export const PrefetchSchema = s.object({
  regexp: s.string,
  path: s.string,
})

export type Prefetch = Infer<typeof PrefetchSchema>

export const PageSchema = s.object({
  title: s.string,
  description: s.string,
  path: s.string,
  imageUrl: s.string,
  source: s.string,
  tags: s.array(s.string).optional,
  prefetch: s.array(PrefetchSchema).optional,
  type: s.string.optional,
  navSort: s.string.optional,
  icon: s.string.optional,
})

export type Page = Infer<typeof PageSchema>

export const emptyPage: Page = {
  title: '',
  description: '',
  path: '',
  imageUrl: '',
  source: '',
  prefetch: [],
  type: 'website',
}
