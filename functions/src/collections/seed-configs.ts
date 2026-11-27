/**
 * The platform's own collections, expressed as DATA.
 *
 * This is the translation of every `COLLECTIONS.x = {...}` in the codebase into
 * the declarative form the registry compiles. Once `/doc` reads from the
 * registry these are seed documents, not code — they live here only so the
 * translation is reviewable and so `equivalence.test.ts` can compare them
 * against the TypeScript they replace.
 *
 * There is no "platform collection" concept in the registry. These are bare
 * names because they belong to the platform's own namespace, and that is the
 * only thing distinguishing them from `virta:task`.
 *
 * `post` and `page` are not here: they are the blog's, installed by its
 * manifest as `blog:post` and `blog:page` (D28, manifests/blog.json).
 *
 * ## Deliberately unchanged behaviour
 *
 * Every rule here reproduces what ships today, including the parts that look
 * odd:
 *
 *   - `role` is OWNER-ONLY for everything (D4). `getUserRoles` derives every
 *     caller's authority from this collection, so whoever writes it rewrites
 *     the input to their own authorization.
 *   - the install records have NO write entry at all, for anyone, so `/doc`
 *     refuses every mutation — they are written only by the install handler.
 */

import type { StoredCollectionConfig } from './registry'
import { ROLES } from './roles'

export const PLATFORM_CONFIGS: StoredCollectionConfig[] = [
  {
    name: 'module',
    namespace: null,
    collection: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          source: { type: 'string' },
          // Matches ModuleSchema. The seed had `{type:'string'}`, `number` and
          // no `tags` requirement, so the swap would have accepted module
          // documents the shipped code refuses (0.2.0-beta.5 review; caught by
          // seed-parity.isolated.ts's schema fixtures).
          version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
          revisions: { type: 'integer', minimum: 0 },
          type: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          _created: { type: 'string' },
          _modified: { type: 'string' },
        },
        required: ['name', 'source', 'version', 'tags'],
      },
      unique: ['name'],
      // Replaces module.ts's revision provenance. The caller cannot send this
      // field, so the carry-forward branch that once erased history is gone.
      envelope: { version: { bumpOn: ['source'] } },
      access: [
        {
          role: ROLES.public,
          read: { visible: { field: 'tags', op: 'includes', value: 'public' } },
          list: {
            visible: {
              all: [
                { field: 'tags', op: 'includes', value: 'public' },
                { field: 'tags', op: 'includes', value: 'visible' },
              ],
            },
          },
        },
        { role: ROLES.developer, read: 'ALL', write: 'ALL', list: 'ALL' },
      ],
    },
  },
  {
    name: 'config',
    namespace: null,
    collection: {
      schema: { type: 'object' },
      cacheLatencySeconds: 300,
      access: [
        { role: ROLES.public, read: 'ALL', list: 'ALL' },
        { role: ROLES.admin, read: 'ALL', write: 'ALL', list: 'ALL' },
      ],
    },
  },
  {
    name: 'role',
    namespace: null,
    collection: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          // Exactly RoleSchema's contacts (shared/role.ts). A contact is
          // AUTHORITY — `findRoleDocs` resolves a principal by it — so the
          // seed's bare `{type:'array'}` accepted contacts the shipped code
          // refuses (0.2.0-beta.5 re-review). Pinned by seed-parity's role
          // schema fixtures.
          contacts: {
            type: 'array',
            items: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    type: { const: 'email' },
                    value: { type: 'string', format: 'email' },
                  },
                  required: ['type', 'value'],
                  additionalProperties: false,
                },
                {
                  type: 'object',
                  properties: {
                    type: { const: 'phone' },
                    value: { type: 'string', pattern: '^\\+?[\\d\\s\\-().]{7,}$' },
                  },
                  required: ['type', 'value'],
                  additionalProperties: false,
                },
                {
                  type: 'object',
                  properties: {
                    type: { const: 'address' },
                    value: { type: 'string', minLength: 1 },
                  },
                  required: ['type', 'value'],
                  additionalProperties: false,
                },
              ],
            },
          },
          roles: { type: 'array', items: { type: 'string' } },
          userIds: { type: 'array', items: { type: 'string' } },
          _created: { type: 'string' },
          _modified: { type: 'string' },
        },
        required: ['name', 'contacts', 'roles', 'userIds'],
      },
      unique: ['name'],
      // OWNER ONLY (D4). Granting `admin` here was the whole escalation chain:
      // admin -> developer -> `module` -> arbitrary JS via /esm.
      access: [{ role: ROLES.owner, read: 'ALL', write: 'ALL', list: 'ALL' }],
    },
  },
  {
    name: 'manifest',
    namespace: null,
    collection: {
      schema: { type: 'object' },
      cacheLatencySeconds: 60,
      // No `write` for anyone — written only by the install handler.
      access: [
        { role: ROLES.configurator, read: 'ALL', list: 'ALL' },
        { role: ROLES.owner, read: 'ALL', list: 'ALL' },
      ],
    },
  },
  {
    name: 'grant',
    namespace: null,
    collection: {
      schema: { type: 'object' },
      cacheLatencySeconds: 60,
      access: [
        { role: ROLES.configurator, read: 'ALL', list: 'ALL' },
        { role: ROLES.owner, read: 'ALL', list: 'ALL' },
      ],
    },
  },
  {
    name: 'install-log',
    namespace: null,
    collection: {
      schema: { type: 'object' },
      access: [
        { role: ROLES.configurator, read: 'ALL', list: 'ALL' },
        { role: ROLES.owner, read: 'ALL', list: 'ALL' },
      ],
    },
  },
  // NO `post/comment`. It was seeded here (public read/list, admin schemaless
  // write), but the shipped code never registers it — the only occurrence is a
  // doc-comment EXAMPLE in access.ts — so the swap would have OPENED a
  // collection that is closed today (0.2.0-beta.5 review, B2). Opening comments
  // is a decision to make on purpose, in both places, not a side effect of a
  // seed. `seed-configs.test.ts` now pins the name sets as equal.
]
