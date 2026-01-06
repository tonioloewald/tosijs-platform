import { s, type Infer } from 'tosijs-schema'

export const ModuleSchema = s.object({
  name: s.string,
  source: s.string,
  version: s.string.pattern(/^\d+\.\d+\.\d+$/),
  revisions: s.integer.min(0),
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
