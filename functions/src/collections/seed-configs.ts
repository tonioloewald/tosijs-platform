/**
 * The nine platform collections, expressed as DATA.
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
 * ## Deliberately unchanged behaviour
 *
 * Every rule here reproduces what ships today, including the parts that look
 * odd:
 *
 *   - `post` is publicly READABLE including drafts. That is intentional —
 *     unpublished posts are unlisted, not secret, so a link can be sent to a
 *     friend for comment. Drafts are excluded from LIST only.
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
    name: 'post',
    namespace: null,
    collection: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          path: { type: 'string' },
          date: { type: 'string' },
          summary: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          imageUrl: { type: 'string' },
          author: { type: 'string' },
          format: { type: 'string' },
          _created: { type: 'string' },
          _modified: { type: 'string' },
        },
        required: ['title', 'content'],
      },
      // Both, each on its own, matching blog.ts (D19: per-field unique).
      unique: ['title', 'path'],
      // Replaces blog.ts's `validate`, which generates a path from the title.
      derive: [{ op: 'slug', to: 'path', from: 'title', when: 'absent' }],
      access: [
        {
          role: ROLES.public,
          // Drafts ARE readable by direct link, deliberately. See the header.
          read: 'ALL',
          // …but never listed. `nonEmpty` covers all three of D11's "empty"
          // shapes; testing `date !== undefined` once leaked 57 drafts.
          list: { visible: { field: 'date', op: 'nonEmpty' } },
        },
        { role: ROLES.author, write: 'ALL', list: 'ALL' },
      ],
    },
  },
  {
    name: 'page',
    namespace: null,
    collection: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          path: { type: 'string' },
          imageUrl: { type: 'string' },
          source: { type: 'string' },
          css: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          type: { type: 'string' },
          navSort: { type: 'string' },
          icon: { type: 'string' },
          _created: { type: 'string' },
          _modified: { type: 'string' },
        },
        required: ['title', 'description', 'path', 'source'],
      },
      // page.ts makes `path` unique; the seed had lost it (caught by
      // seed-parity.test.ts, D19).
      unique: ['path'],
      tagFields: ['tags'],
      access: [
        {
          role: ROLES.public,
          read: { visible: { field: 'tags', op: 'includes', value: 'public' } },
          // LIST needs `public` AND `visible`: a public-but-not-visible page is
          // reachable by link and deliberately absent from navigation. The seed
          // required only `public`, so the swap would have listed unlisted
          // pages to everyone.
          list: {
            visible: {
              all: [
                { field: 'tags', op: 'includes', value: 'public' },
                { field: 'tags', op: 'includes', value: 'visible' },
              ],
            },
          },
        },
        { role: ROLES.admin, read: 'ALL', write: 'ALL', list: 'ALL' },
      ],
    },
  },
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
          contacts: { type: 'array' },
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
