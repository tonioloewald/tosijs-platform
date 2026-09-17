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
  // OPTIONAL. Was required, which made one of the two live pages unwritable —
  // it has no featured image and never has. `PostSchema.imageUrl` was already
  // optional, so requiring it here was an inconsistency rather than a rule, and
  // nothing reads it unconditionally. Found 2026-09-16 by validating stored
  // production data against the schemas (`stored-data-health.test.ts`).
  imageUrl: s.string.optional,
  source: s.string,
  // Per-page CSS. Undeclared until 2026-09-16 although a live page has carried
  // it for as long as the backups go back — tosijs-schema rejects unexpected
  // properties, so that page could not be saved.
  css: s.string.optional,
  tags: s.array(s.string).optional,
  prefetch: s.array(PrefetchSchema).optional,
  type: s.string.optional,
  navSort: s.string.optional,
  icon: s.string.optional,
  // The /doc endpoint stamps these BEFORE schema validation, and tosijs-schema
  // is strict about unexpected properties — so without them every page write
  // failed with "Unexpected _created". Post and Module already had them; page
  // was missed, and no test caught it because the integration suite had never
  // actually run (2026-09-06).
  _created: s.string.optional,
  _modified: s.string.optional,
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
