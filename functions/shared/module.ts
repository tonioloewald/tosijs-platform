import { s, type Infer } from 'tosijs-schema'

export const ModuleSchema = s.object({
  name: s.string,
  source: s.string,
  version: s.string.pattern(/^\d+\.\d+\.\d+$/),
  // OPTIONAL ON INPUT. `module.validate` is what sets this (0 on create, +1 when
  // `source` changes), and doc.ts runs schema validation BEFORE the transform —
  // so requiring it made creating a module through the endpoint impossible: the
  // schema demanded a field only the later stage could supply. It is
  // endpoint-managed provenance, not caller data.
  revisions: s.integer.min(0).optional,
  tags: s.array(s.string),
  _created: s.string.optional,
  _modified: s.string.optional,
})

export type Module = Infer<typeof ModuleSchema>

export const emptyModule: Module = {
  name: '',
  source: '',
  version: '0.0.0',
  revisions: 0,
  tags: [],
}
