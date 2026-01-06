import { s, type Infer } from 'tosijs-schema'

export const LinkSchema = s.object({
  level: s.integer,
  title: s.string,
  url: s.string,
})

export type Link = Infer<typeof LinkSchema>

export const BookSchema = s.object({
  title: s.string,
  sectionIds: s.array(s.string),
  tableOfContents: s.array(LinkSchema),
})

export type Book = Infer<typeof BookSchema>

export const BlockTypeSchema = s.object({
  description: s.string,
  tagType: s.string,
  nextType: s.string,
})

export type BlockType = Infer<typeof BlockTypeSchema>

export const blockTypes: BlockType[] = [
  {
    description: 'heading (h1)',
    tagType: 'h1',
    nextType: 'body',
  },
  {
    description: 'heading (h2)',
    tagType: 'h2',
    nextType: 'body',
  },
  {
    description: 'heading (h3)',
    tagType: 'h3',
    nextType: 'body',
  },
  {
    description: 'heading (h4)',
    tagType: 'h4',
    nextType: 'body',
  },
  {
    description: 'body',
    tagType: 'p',
    nextType: 'text',
  },
  {
    description: 'image',
    tagType: 'img',
    nextType: 'caption',
  },
  {
    description: 'caption',
    tagType: 'p',
    nextType: 'body',
  },
  {
    description: 'quote',
    tagType: 'blockquote',
    nextType: 'body',
  },
  {
    description: 'list (bullet)',
    tagType: 'ul',
    nextType: 'caption',
  },
  {
    description: 'list (numbered)',
    tagType: 'ol',
    nextType: 'caption',
  },
]

export const BlockSchema = s.object({
  type: s.string,
})

export type Block = Infer<typeof BlockSchema>

export const SectionSchema = s.object({
  title: s.string,
  blocks: s.array(BlockSchema),
})

export type Section = Infer<typeof SectionSchema>
