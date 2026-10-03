# Computed collections — design for adversarial review

Status: proposal (owner, 2026-10-03). Board #2810. Engine prototype: `functions/src/render/computed.ts`,
used by render on store (D23, `functions/src/render/store.ts`). Not yet exposed as a collection rule.

## The idea

A collection rule that lets a document or a listing **come into existence on read**. Before, reading a
document that does not exist was a dead end: Firestore says "not found", no code runs. Now a miss is an
event a rule handles. It is the data equivalent of an ES `Proxy`, integrated with the platform's RBAC.

A computed collection has three rules, each optional:

| rule | Proxy analogue | runs when | default |
|---|---|---|---|
| **read** | `get` | a `/doc` read misses (absent or stale) | plain not-found |
| **list** | `ownKeys` | a `/docs` query arrives; the rule decides what exists for it | plain query |
| **write** | `set` | a write arrives | normal write pipeline |

Write rules: `refuse` (read-only, e.g. sitemap); `override` (a write pins a real value that wins and
opts out of dependency invalidation, e.g. an author edits an auto-generated summary); `through` (a lens:
the write is mapped onto source documents; simple mappings with an inverse only); `store` (normal
writes, with computed fallbacks for documents nobody wrote).

## Caching and staleness (policies on top)

- A computed result may be **stored** (materialized) or not (computed per read).
- **Recorded dependencies**: while computing, every read is recorded: `doc:<collection>/<id>`,
  `doc:<collection>/<field>=<value>` (unique-field lookup), `list:<collection>` (any query on it),
  `computed:<key>` (another computed value). A committed write invalidates every stored value whose deps
  include the written document, its unique-field lookups before AND after, or its collection's lists;
  invalidation cascades through `computed:` deps. No hand-written invalidation rules.
- **maxAgeSeconds**: for values derived from things that never write to us (external URLs).
- **validate**: a check on every read (e.g. a checksum of the sources stored with the value).
- **Version namespace**: bump it when the rule's code changes; every key misses and recomputes lazily.
- **Race**: a read computing across a write could store pre-write data after the write's invalidation.
  Invalidation writes a stale marker (never deletes); a reader stores only if the key is unchanged
  since it looked (Firestore update-time precondition). Losing the race: return the value, do not store.
- **Negative results** (the key does not apply, e.g. the named post does not exist) are stored as
  `null` with their deps, so an unknown key costs nothing until its source appears.

## Access (RBAC)

- The collection's ordinary access rules govern read/list/write as for any collection. A rule runs
  only after the caller has passed the corresponding access check.
- **Whose rights does the compute run with?** In render on store: always the PUBLIC (an anonymous
  request), so a stored value never contains anything a privileged reader could see (D10). For general
  computed collections this is an open question (see "Questions for reviewers").
- Rules are named host functions today; stored ajs later (capability-gated, fuel-metered). Markdown and
  highlighting are host capabilities (D23).

## How invalidation is triggered

`afterWrite` hooks on source collections (post, page, config today) receive `{path, before, after}` from
every committed write path (`/doc` write, `/doc` delete, transactional commit via `/docs` batches and
`/blob` metadata) and call `invalidateDependents(depsOfWrite(...))`.

## Lists

The list rule receives the normalized query (filters, order, limit, cursor) and returns rows with a
stable sort key; the cursor is that key. Results may be cached, keyed by the normalized query, with
deps recorded the same way. Stated invariant (testable, not enforced): every listed row is gettable.

## First instances

Rendered SSR pages (per route), the nav fragment, the blog index fragment, the route table, the
sitemap, `cachedQuery` (external URL, maxAge 24h), RSS (later).

## Questions for reviewers

1. Whose rights should a general computed rule run with: the reader, a fixed principal (public, the
   rule's installer), or something else? What breaks with each, given that results are CACHED and shared?
2. Is dependency recording complete? What writes can change a computed value without invalidating it?
3. What can a caller do with the miss hook that they could not do before (cost, probing, amplification)?
4. Are the write rules (`override`, `through`, `store`) sound with respect to caching and RBAC?
5. Does the list rule interact badly with access filters, pagination, or the get/list invariant?
