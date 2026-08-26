# Universal Endpoint — Gap Analysis (current code → spec)

> Phase-1 worklist. Maps each piece of [UNIVERSAL-ENDPOINT.md](UNIVERSAL-ENDPOINT.md) to what
> exists in `functions/src/` today (`doc.ts`, `docs.ts`, `collections/access.ts`, `utilities.ts`)
> and what has to change. See [ROADMAP.md](ROADMAP.md) for why. Invariants (§9) are scaffolded
> separately in `functions/src/collections/universal-endpoint.invariants.test.ts`.

**Disposition legend:** **Port** = exists, adapt as-is · **Expand** = exists but must grow ·
**Replace** = exists in a different shape/trust model, rebuild · **New** = nothing today ·
**Delete** = current thing goes away.

## The five structural shifts (read these first)

1. **Trusted TS logic → untrusted-but-safe ajs.** Today `validate()` and the `access` filter
   functions are *trusted TypeScript* in `COLLECTIONS`, running with full ambient authority and
   redeployed on change. The spec makes them *stored ajs* evaluated by the VM with an injected
   capability set. This is the whole point, and it inverts the trust model of `access.ts`.
2. **One `validate` → two stages with different powers.** `validate(data, roles, existing)` is one
   function that both *transforms* and *gates* and *sees the existing doc*. It splits into
   **`beforeWrite`** (body transform, caller caps, no privileged read, idempotent) and
   **`isWriteAllowed`** (boolean, whole-transaction, privileged read, no write). The current
   single-function shape cannot be ported; its *logic* is redistributed.
3. **Single-doc → whole-transaction writes.** `doc.ts` writes exactly one document; `isWriteAllowed`
   is defined over the entire touched set (before/after per doc). Multi-doc atomic commit is new
   plumbing, and it is what makes cross-doc invariants (incl. today's `unique`) expressible.
4. **Body and provenance are mixed → body vs envelope.** Today `_created`/`_modified` (doc.ts) and
   `_id`/`_collection` (utilities) are stamped into the *same object* as the content. The spec
   separates a server-owned **envelope** from the caller **body**; user ajs never sees the envelope.
   This is a data-model change with a migration.
5. **Full-refetch reads → pull-only versioned deltas.** No sequence, no tombstones, no `since`
   today. The spec adds a monotonic per-collection sequence + tombstones + `docs(path,{since})`,
   feeding both the client replica and SSR invalidation.

## Mapping table

| Spec | Today (file · concept) | Disposition | Notes |
|------|------------------------|-------------|-------|
| §1 ajs VM + capability injection + fuel | — (validate/access are plain TS) | **New** | tjs-lang 0.13.1 supplies the VM; build the per-call capability set + fuel metering. |
| §1 `doc` (single-doc CRUD) | `doc.ts` GET/POST/PUT/PATCH/DELETE | **Expand** | Keep the endpoint; reroute its pipeline through §3; POST=create/PUT=update guards port. |
| §1 `docs` (query) | `docs.ts` + `getRecords` | **Expand** | See §7 row. |
| §1 `procedures` | — | **New** | Stored, versioned ajs; every write goes through §3. |
| §1 `ssr` | `prefetch.ts` | **Replace** | Per ROADMAP: SSR-data-injection dies, becomes the cached-HTML page server. Out of scope here. |
| §2.1 procedures run with caller caps | — (TS runs as trusted) | **New** | Enforced by the injected capability set, not convention. |
| §2.2 amplification only in `isWriteAllowed` (privileged read, no write) | `validate()` receives `existing` (single-doc privileged read) but is trusted + can transform | **Replace** | Privileged read moves behind a boolean, write-less rule. |
| §2.5 rule installation = most-privileged write | Rules are TS in `COLLECTIONS`, deployed | **Replace** | Rules become stored data; installing them needs a capability procedures/transforms can't hold. |
| §3 pipeline order (beforeWrite→no-op→isWriteAllowed→commit) | `doc.ts`: schema → validate → unique → stamp → set | **Replace** | Same spirit, re-sequenced and re-split; ordering is now a security property. |
| §3 schema validation | `validateWithSchema` (tosijs-schema) | **Port** | Already schema-first + serializable; keep as the pre-`beforeWrite` gate. |
| §3 no-op check (normalized body == stored) | — | **New** | Requires a canonical body normalization (really part of `beforeWrite`'s fixed point). |
| §3 commit stamps envelope | `doc.ts` stamps `_created`/`_modified` inline | **Expand→Replace** | Move to a separate envelope; add `version`, `author`, `savedAt`, per-collection `seq`. |
| §3 multi-doc transaction | — (single doc) | **New** | Buffered/transactional commit. |
| §4.1 `beforeWrite` (body, caller caps, injected clock, idempotent) | `validate()` (transform half) | **Replace** | Drop ambient `Date.now()`; body-only; provably idempotent (§6/§9.7 test). |
| §4.2 `isWriteAllowed` (boolean, whole-txn, privileged read, no write) | `validate()` (gate half) + `unique` | **Replace** | Fuel-exhaust/throw/non-bool ⇒ `false`. |
| §4.3 procedures (versioned, logged, schema-pinned) | — | **New** | Old versions retained; every invocation logged (§9.11). |
| §5 body vs envelope | `_created`/`_modified`/`_id`/`_collection` mixed into data | **Replace** | Envelope unreachable from ajs; migration for existing docs. |
| §6 idempotence-as-infrastructure (property test, no-op, migration discovery, replay) | tjs implicit/property tests exist as a mechanism | **New** | Wire the fixed-point generator per path with a `beforeWrite`. |
| §7 query semantics owned by endpoint, **Postgres-reference** | `docs.ts`: single `orderBy`, `limit`, `.select(fields)`, `tagField=` array-contains | **Expand** | Add offset, multiple inequalities, ordered listing to Postgres semantics; Firestore emulates in-endpoint. |
| §7 unindexed-queries-fail + schema-declared queryable fields | `tagFields` (seed); no enforcement | **New/Expand** | Schema declares queryable; generate `firestore.indexes.json`; reject unindexed. |
| §7.1 `docref` + built-in inner join | — (no references/join) | **New** | New tosijs-schema keyword; `docs(path,{join})`; delete-restrict; invalidation edge. |
| §7.2 versioned delta (`seq`, tombstones, `since`) | — (full refetch); DELETE hard-deletes | **New** | Monotonic per-collection seq; tombstones; `docs(path,{since})`. |
| §7.2 session-keyed encrypted client cache | `firebase.ts` plain in-memory `getRecords` cache | **Replace** | Client-side; key derives from session so it dies on auth change. |
| §10 `isReadAllowed` (boolean row rule) | `access.read`/`list` AccessFilterFunc returning `Error` to mask | **Port** | Row-level masking already exists; port to a boolean rule. |
| §10 field-level **read projection** | `FieldAccessMap` + `getMethodAccess` field-strain + `docs.ts` `.select(f)` | **Gap — decide** | The spec has *no* field-level read; today does. See Decisions. |
| field-level **write** restriction | `FieldAccessMap` on `write` | **Replace→`beforeWrite`** | `beforeWrite` strips/rejects fields the caller may not set; moves declarative → ajs. |
| role hierarchy + precedence walk | `roles.ts` 6-level; `getMethodAccess` last-matching-role-wins | **Port** | Becomes the principal/auth capability; precedence semantics preserved. |
| `getUserRoles` / auth | `utilities.ts` (token → roles, custom-claims sync) | **Port** | The auth capability / principal resolution. |
| `getRef` / path parsing / `collectionPath` | `doc.ts` / `access.ts` | **Port** | Path→store-ref stays. |
| `unique` constraint | `access.ts` config + `isUnique` (doc.ts) | **Port→invariant** | Becomes an `isWriteAllowed` cross-doc invariant *or* an indexed uniqueness constraint (decide). |
| `cacheLatencySeconds` read cache | `access.ts` config | **Reconsider** | Overlaps §7.2 delta + SSR cache; may fold in. |
| `/gen`, `/stored` | endpoints | **Port→capabilities** | Become batteries reached through a stingy interface (ROADMAP invariant: they don't dissolve). |
| `/sitemap` | `sitemap.ts` | **Delete** | tosijs-ui build emits `sitemap.xml`. |
| Firestore security rules | `firestore.rules` (deny-all) | **Keep (N/A)** | Already deny-all; all access is through the endpoint. |

## Decisions needed (blockers or forks)

1. **Field-level read projection.** The spec's `isReadAllowed` is a row boolean; today a role can be
   shown a *subset of fields* (`FieldAccessMap`, list `.select`). Options: (a) schema-declared
   per-role read projections (declarative, stays serializable, matches "schema = intra-document");
   (b) a `beforeRead`/projection ajs stage; (c) drop field-level read (coarser than today —
   probably unacceptable for the public-sees-published-summary case). **Recommend (a).**
2. **`unique` → invariant vs. constraint.** As an `isWriteAllowed` cross-doc check it's uniform but
   costs a privileged read per write; as an indexed uniqueness constraint it's cheaper but backend-
   specific. Decide per the Postgres-reference stance.
3. **Unindexed-queries-fail** (spec §7, "decision pending"). Adopt as universal, or "runs slowly +
   mandatory observability." Adopting is the behavior change that makes "scale without thinking"
   real, but it will start erroring some existing loose Firestore queries.
4. **Hard-delete → tombstones.** `doc.ts` DELETE currently hard-deletes; §7.2 deltas need tombstones
   and a sequence. This is a store-schema change (and interacts with the client's existing
   `deleted` collection convention).
5. **Envelope migration.** Existing docs carry `_created`/`_modified`/`_id`/`_collection` in-band.
   Moving to an envelope needs a one-time migration (a natural first customer for §6.3 fixed-point
   migration tooling).

## Ports cleanly (low risk)

tosijs-schema validation · `getUserRoles`/auth · path parsing (`getRef`, `collectionPath`) · the
role hierarchy + precedence semantics · row-level read masking (→ `isReadAllowed`) · `/gen` &
`/stored` as batteries. These are the trusted core the ROADMAP says survives.
