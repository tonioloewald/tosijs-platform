/**
 * Manifest validation (tosijs-platform#5).
 *
 * The refusals are the content. A manifest is third-party input that becomes
 * collection config, schemas and access rules on someone else's host, so
 * "accepted a bad manifest" is the failure mode that matters — not "rejected a
 * good one".
 *
 * Two of these guard MEASURED defects in tosijs-schema 1.9.0 rather than
 * hypothetical ones; see the `$predicate` and `contains` tests, which assert the
 * upstream behaviour first so the reason cannot rot into folklore.
 *
 * Run: cd functions && bun test src/install/manifest.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { validate, unenforcedKeywords, type ErrorHandler } from 'tosijs-schema'

/** Named so eslint's no-empty-function rule has something to hold onto. */
const ignoreErrors: ErrorHandler = () => undefined

import {
  validateManifest,
  assertSafeSchema,
  validateVisibility,
  unenforcedCapabilities,
  ENFORCED_CAPABILITY_KINDS,
  type Manifest,
} from './manifest'
import { ROLES } from '../collections/roles'

const KNOWN_ROLES = Object.values(ROLES)
const opts = {
  unenforced: (s: Record<string, unknown>) =>
    unenforcedKeywords(s as never) as string[],
  knownRoles: KNOWN_ROLES,
}

const ok = (over: Partial<Manifest> = {}): Manifest => ({
  manifest: 1,
  name: 'virta',
  version: '0.1.0',
  collections: {
    'virta:task': {
      schema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
      access: [{ role: ROLES.admin, read: 'ALL', write: 'ALL', list: 'ALL' }],
    },
  },
  ...over,
})

const messages = (errs: Error[]) => errs.map((e) => e.message).join('\n')

describe('a well-formed manifest passes', () => {
  test('no problems', () => {
    expect(validateManifest(ok(), opts)).toEqual([])
  })
})

describe('format version is checked FIRST', () => {
  test('an unknown version refuses outright, with ONE error', () => {
    // Every other check assumes the v1 shape. Reporting a pile of shape errors
    // for a v2 manifest would be noise pointing at the wrong problem.
    const errs = validateManifest({ ...ok(), manifest: 2 }, opts)
    expect(errs).toHaveLength(1)
    expect(messages(errs)).toContain('unsupported manifest version')
  })

  test('a missing version refuses', () => {
    expect(validateManifest({ name: 'virta' }, opts)).toHaveLength(1)
  })
})

describe('declarative-only: `functions` is REFUSED, not ignored', () => {
  test('presence is a hard failure', () => {
    // Silently dropping the executable half of a manifest and reporting success
    // is the worst available outcome.
    const errs = validateManifest({ ...ok(), functions: {} } as never, opts)
    expect(messages(errs)).toContain('DECLARATIVE manifests only')
  })
})

describe('namespace gate', () => {
  test('a manifest may not declare a platform collection', () => {
    const errs = validateManifest(
      ok({ collections: { role: ok().collections['virta:task'] } as never }),
      opts
    )
    expect(messages(errs)).toContain('platform collection')
  })

  test('a manifest may not declare another namespace', () => {
    const errs = validateManifest(
      ok({ collections: { 'blog:post': ok().collections['virta:task'] } as never }),
      opts
    )
    expect(messages(errs)).toContain('belongs to "blog"')
  })

  test('an invalid manifest name is reported', () => {
    expect(messages(validateManifest(ok({ name: 'Virta' }), opts))).toContain(
      '"name" must be a valid namespace'
    )
  })
})

describe('schema safety — measured tosijs-schema defects', () => {
  test('UPSTREAM: $predicate with no evaluator accepts anything', () => {
    // Asserted first so the refusal below has a visible reason. If this ever
    // starts failing, upstream fixed it and the by-name refusal can be revisited.
    expect(validate('literally anything', { type: 'string', $predicate: 'nope' } as never, ignoreErrors)).toBe(true)
  })

  test('UPSTREAM: $predicate is INVISIBLE to unenforcedKeywords', () => {
    // Which is why it needs its own check — the generic gate cannot see it.
    expect(unenforcedKeywords({ type: 'string', $predicate: 'nope' } as never)).toEqual([])
  })

  test('$predicate is refused by name, at any depth', () => {
    const nested = {
      type: 'object',
      properties: { a: { type: 'object', properties: { b: { $predicate: 'x' } } } },
    }
    const errs = assertSafeSchema(nested, 'schema', opts.unenforced)
    expect(messages(errs)).toContain('"$predicate" is not allowed')
  })

  test('UPSTREAM: `contains` is accepted but NOT enforced', () => {
    const s = {
      type: 'object',
      properties: { tags: { type: 'array', contains: { const: 'public' } } },
    }
    // A document that plainly violates it passes.
    expect(validate({ tags: ['nope'] }, s as never, { onError: ignoreErrors, strict: true })).toBe(true)
    // …but the keyword IS reported as ignored, so the gate can catch it.
    expect(unenforcedKeywords(s as never)).toContain('root.properties.tags.contains')
  })

  test('a schema using an ignored keyword is refused', () => {
    const errs = assertSafeSchema(
      {
        type: 'object',
        properties: { tags: { type: 'array', contains: { const: 'public' } } },
      },
      'schema',
      opts.unenforced
    )
    expect(messages(errs)).toContain('IGNORES')
  })

  test('projection and accept schemas are checked too, not just the stored one', () => {
    const errs = validateManifest(
      ok({
        collections: {
          'virta:task': {
            schema: { type: 'object', properties: { t: { type: 'string' } } },
            access: [
              {
                role: ROLES.author,
                read: { project: { type: 'object', properties: { t: { $predicate: 'x' } } } },
              },
            ],
          },
        },
      }),
      opts
    )
    expect(messages(errs)).toContain('$predicate')
  })
})

describe('unique constraints', () => {
  test('one field is fine', () => {
    expect(
      validateManifest(
        ok({
          collections: {
            'virta:task': { ...ok().collections['virta:task'], unique: ['slug'] },
          },
        }),
        opts
      )
    ).toEqual([])
  })

  test('a composite constraint is refused — it would need a deploy', () => {
    // firestore.indexes.json is a deployment artifact, and "install without
    // deploying" is the entire premise.
    const errs = validateManifest(
      ok({
        collections: {
          'virta:task': {
            ...ok().collections['virta:task'],
            unique: ['a', 'b'],
          },
        },
      }),
      opts
    )
    expect(messages(errs)).toContain('needs an index, which is a deployment')
  })
})

describe('access rules', () => {
  test('access must be an ARRAY, because order must not matter', () => {
    const errs = validateManifest(
      ok({
        collections: {
          'virta:task': {
            schema: { type: 'object' },
            access: { [ROLES.admin]: { read: 'ALL' } } as never,
          },
        },
      }),
      opts
    )
    expect(messages(errs)).toContain('must be an ARRAY')
  })

  test('a manifest may not invent a role', () => {
    const errs = validateManifest(
      ok({
        collections: {
          'virta:task': {
            schema: { type: 'object' },
            access: [{ role: 'virta-admin', read: 'ALL' }],
          },
        },
      }),
      opts
    )
    expect(messages(errs)).toContain('not a role this host defines')
  })

  test('usesRoles may not invent one either', () => {
    const errs = validateManifest(ok({ usesRoles: ['superuser'] }), opts)
    expect(messages(errs)).toContain('never create principals')
  })

  test('a restricted write must say what it accepts', () => {
    const errs = validateManifest(
      ok({
        collections: {
          'virta:task': {
            schema: { type: 'object' },
            access: [{ role: ROLES.author, write: { visible: { field: 'owner', op: 'eq', value: 'x' } } as never }],
          },
        },
      }),
      opts
    )
    expect(messages(errs)).toContain('must declare "accept"')
  })
})

describe('visibility predicates', () => {
  test('the closed vocabulary is accepted', () => {
    expect(validateVisibility({ field: 'tags', op: 'includes', value: 'public' }, 'v')).toEqual([])
    expect(validateVisibility({ field: 'date', op: 'nonEmpty' }, 'v')).toEqual([])
  })

  test('all/any nest', () => {
    expect(
      validateVisibility(
        { all: [{ field: 'tags', op: 'includes', value: 'public' }, { field: 'date', op: 'nonEmpty' }] },
        'v'
      )
    ).toEqual([])
  })

  test('an unknown op is refused rather than ignored', () => {
    // An ignored predicate is a grant, so an unknown op must never be skipped.
    expect(messages(validateVisibility({ field: 'x', op: 'matches' }, 'v'))).toContain('unknown op')
  })

  test('an empty all/any is refused', () => {
    // `all: []` is vacuously true — i.e. visible to everyone.
    expect(messages(validateVisibility({ all: [] }, 'v'))).toContain('non-empty')
  })
})

describe('the validator reports EVERY problem, not just the first', () => {
  test('a manifest with several mistakes yields several errors', () => {
    const errs = validateManifest(
      ok({
        name: 'virta',
        version: 'not-semver',
        collections: {
          role: { schema: { type: 'object' }, access: [{ role: 'nope', read: 'ALL' }] },
        },
      }),
      opts
    )
    // version + platform-collection + unknown-role, at least.
    expect(errs.length).toBeGreaterThanOrEqual(3)
  })
})

describe('capabilities — the shape settled 2026-09-19 (#11)', () => {
  const cap = (capabilities: unknown) =>
    validateManifest(ok({ capabilities } as never), opts).map((e) => e.message)

  test('an ARRAY is refused with the reason, not silently accepted', () => {
    // The old shape. An array carries no identity, so an upgrade that
    // reordered it looked like a change and one that renamed a capability
    // looked like none.
    expect(cap([{ kind: 'blob' }]).join()).toContain('keyed by name')
  })

  test('an unrecognised kind is refused', () => {
    // Closed vocabulary, like DERIVE_OPS: a kind nothing can enforce must not
    // be granted. "Granted but unenforceable" is strictly worse than refused.
    expect(cap({ 'virta:x': { kind: 'mine-bitcoin' } }).join()).toContain(
      'not a capability this host recognises'
    )
  })

  test('a recognised kind passes', () => {
    expect(cap({ 'virta:files': { kind: 'blob', maxBytes: 10 } })).toEqual([])
  })

  test('it must be NAMESPACED, like a collection', () => {
    expect(cap({ notify: { kind: 'email' } }).join()).toContain('un-namespaced')
    expect(cap({ 'other:notify': { kind: 'email' } }).join()).toContain(
      'belongs to "other"'
    )
  })

  test('NO access is legal — it means nobody, which is the default', () => {
    // Declared, inert, safe. The upgrade that later adds a rule re-triggers
    // approval because the declaration changed.
    expect(cap({ 'virta:files': { kind: 'blob' } })).toEqual([])
  })

  test('a rule naming an unknown role is refused', () => {
    expect(
      cap({
        'virta:files': { kind: 'blob', access: [{ role: 'wizard', use: 'ALL' }] },
      }).join()
    ).toContain('not a role this host defines')
  })

  test('a rule that grants nothing is a mistake, not a deny', () => {
    // Silence would read as "I wrote a rule, so something is granted".
    expect(
      cap({
        'virta:files': { kind: 'blob', access: [{ role: 'admin' }] },
      }).join()
    ).toContain('use: required')
  })

  test('an argument constraint is validated like row visibility', () => {
    expect(
      cap({
        'virta:files': {
          kind: 'blob',
          access: [
            { role: 'admin', use: { visible: { field: 'bytes', op: 'nope' } } },
          ],
        },
      }).join()
    ).toContain('unknown op')
  })

  test('a CEILING is expressible — the point of lte/gte', () => {
    // Without these the vocabulary cannot express the most common capability
    // constraint, which would mean settling a shape already known to be wrong.
    expect(
      cap({
        'virta:files': {
          kind: 'blob',
          access: [
            {
              role: 'admin',
              use: { visible: { field: 'bytes', op: 'lte', value: 1000000 } },
            },
          ],
        },
      })
    ).toEqual([])
  })
})

describe('unenforcedCapabilities', () => {
  test('every recognised kind is currently unenforced, and says so', () => {
    // ENFORCED_CAPABILITY_KINDS is deliberately empty: the shape is settled,
    // enforcement is not built (#11). If this test starts failing, something
    // began claiming to enforce a capability and the install response's
    // `unenforced` list needs re-checking.
    expect(ENFORCED_CAPABILITY_KINDS).toEqual([])
    expect(
      unenforcedCapabilities({
        manifest: 1,
        name: 'virta',
        version: '1.0.0',
        collections: {},
        capabilities: { 'virta:files': { kind: 'blob' } },
      })
    ).toEqual(['virta:files'])
  })
})

describe('envelope.seq (#14)', () => {
  const env = (envelope: unknown) =>
    validateManifest(
      ok({
        collections: {
          'virta:event': {
            schema: { type: 'object' },
            envelope,
            access: [{ role: ROLES.author, read: 'ALL' }],
          },
        },
      } as never),
      opts
    ).map((e) => e.message)

  test('a boolean is accepted', () => {
    expect(env({ seq: true })).toEqual([])
    expect(env({ seq: false })).toEqual([])
  })

  test('a non-boolean is refused rather than coerced', () => {
    // `seq: "yes"` silently meaning false would leave a consumer replicating
    // a collection that assigns no sequence, which reads as "no new events".
    expect(env({ seq: 'yes' }).join()).toContain('must be true or false')
  })

  test('it composes with envelope.version', () => {
    expect(env({ seq: true, version: { bumpOn: ['x'] } })).toEqual([])
  })
})
