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

## Milestones — the acceptance ladder ("no function deployment")

The universal endpoint is *done* when a **vanilla server** (this backend, deployed once) can host
features added purely as **data** — stored procedures + collection configs + client code — with
**zero function deploys**. That is the acceptance test, and it comes in independently-shippable
rungs, each shrinking the bespoke function surface:

1. **Drop-in endpoint parity.** The universal `doc`/`docs` behaviourally replace the existing
   loewald.com endpoints. Run in shadow mode (compute alongside the current TS, commit nothing)
   until the diff is clean, then cut over.
2. **Prefetch becomes a stored procedure.** The work `prefetch.ts` does — assemble prefetch data /
   render-and-cache the page HTML (the [Serving model](UNIVERSAL-ENDPOINT.md) virtual page) — moves
   into a stored ajs procedure. Retire `prefetch.ts` the *function*.
3. **Storage capability → asset manager.** Add the `storage` battery (a capability, gated by the
   caller's token like any other); the asset-manager runs against it (upload/list/delete), folding
   in today's bespoke `/stored`.
4. **Add a feature with no deploy — the proof.** On a vanilla server, stand up a **module editor**,
   the **blog system**, and so on as stored procedures + configs + client code, with **no function
   deployment**. This is the README's "PHP/LAMP simplicity, now on the server" made literal.

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
| §6 idempotence-as-infrastructure (property test, no-op, migration discovery, replay) | tjs implicit/property tests exist as a mechanism | **New** | Wire the fixed-point generator per path with a `beforeWrite`. **Tested, not runtime-enforced** — a violation is an author bug, surfaced (failing test + health check), not prevented. |
| §7 query semantics owned by endpoint, **Postgres-reference** | `docs.ts`: single `orderBy`, `limit`, `.select(fields)`, `tagField=` array-contains | **Expand** | Add offset, multiple inequalities, ordered listing to Postgres semantics; Firestore emulates in-endpoint. |
| §7 gas-metered queries + schema-declared queryable fields | `tagFields` (seed); no enforcement | **New/Expand** | Resolved: scans are gas-metered (exhaust gas at scale; never a special "no index" error). Schema declares queryable; generate `firestore.indexes.json`. |
| §7.1 `docref` + built-in inner join | — (no references/join) | **New** | New tosijs-schema keyword; `docs(path,{join})`; delete-restrict; invalidation edge. |
| §7.2 versioned delta (`seq`, tombstones, `since`) | — (full refetch); DELETE hard-deletes | **New** | Monotonic per-collection seq; tombstones (may be *virtual* — a per-collection dead-id list); `docs(path,{since})`. |
| §7.2 session-keyed encrypted client cache | `firebase.ts` plain in-memory `getRecords` cache | **Replace** | Client-side; key derives from session so it dies on auth change. |
| §10 `isReadAllowed` (boolean row rule) | `access.read`/`list` AccessFilterFunc returning `Error` to mask | **Port** | Row-level masking already exists; port to a boolean rule. |
| §10 field-level **read projection** | `FieldAccessMap` + `getMethodAccess` field-strain + `docs.ts` `.select(f)` | **Port→schema** | Resolved: read permission *is* a (sub)schema; endpoint strains each visible doc through it (schema = guard + strainer). |
| field-level **write** restriction | `FieldAccessMap` on `write` | **Replace→`beforeWrite`** | `beforeWrite` strips/rejects fields the caller may not set; moves declarative → ajs. |
| role hierarchy + precedence walk | `roles.ts` 6-level; `getMethodAccess` last-matching-role-wins | **Port** | Becomes the principal/auth capability; precedence semantics preserved. |
| `getUserRoles` / auth | `utilities.ts` (token → roles, custom-claims sync) | **Port** | The auth capability / principal resolution. |
| `getRef` / path parsing / `collectionPath` | `doc.ts` / `access.ts` | **Port** | Path→store-ref stays. |
| `unique` constraint | `access.ts` config + `isUnique` (doc.ts) | **Port→invariant** | `isWriteAllowed` reject-only (privileged read finds collision → `false`; cannot mint); `beforeWrite` may mint the value. Index-backed constraint is the fast path. |
| `cacheLatencySeconds` read cache | `access.ts` config | **Reconsider** | Overlaps §7.2 delta + SSR cache; may fold in. |
| `/gen`, `/stored` | endpoints | **Port→capabilities** | Become batteries reached through a stingy interface (ROADMAP invariant: they don't dissolve). |
| `/sitemap` | `sitemap.ts` | **Delete** | tosijs-ui build emits `sitemap.xml`. |
| Firestore security rules | `firestore.rules` (deny-all) | **Keep (N/A)** | Already deny-all; all access is through the endpoint. |

## Decisions (resolved 2026-08)

1. **Field-level read projection → a schema.** A role's read permission *is* a (sub)schema; the
   endpoint strains each visible document through it. This is the schema-first payoff — schema is
   guard *and* strainer, type-sound (output type = the projection schema). Row visibility stays a
   boolean `isReadAllowed`; field-level *write* restriction is the mirror (`beforeWrite` strips
   fields the caller may not set). *"Super easy" — no separate projection ajs.*
2. **`unique` → `isWriteAllowed` reject-only + optional `beforeWrite` mint.** Because
   `isWriteAllowed` cannot mutate, it can only *reject* a missing/duplicate unique value (privileged
   read detects the collision → `false`); it cannot fix one. Deriving/minting a unique value (where
   RBAC permits) is `beforeWrite`'s job. Concurrency soundness rides the transactional commit; an
   index-backed constraint is the fast path where a backend offers it.
3. **Unindexed queries are gas-metered, not specially failed.** A scan burns gas fast, so it
   succeeds on a small collection and *exhausts gas* on a large one — the failure mode is always gas
   exhaustion, never a bespoke "no index" error (it must not "just fail"). Indexing is the
   optimization that keeps a query under gas; the missing index is recovered from the cost log.
   *(This resolves the spec's §7 "decision pending" — reject the hard "unindexed fails" rule.)*
4. **Hard-delete → tombstones, possibly virtual.** `doc.ts` DELETE currently hard-deletes; §7.2
   deltas need tombstones + a sequence. Tombstones need not be physical per-doc records — a compact
   per-collection list of dead ids ("virtual tombstones") that the `since` query consults works and
   can be compacted/retired as replicas pass the watermark. Interacts with the client's existing
   `deleted`-collection convention.
5. **Envelope migration falls out of idempotence.** Existing docs carry
   `_created`/`_modified`/`_id`/`_collection` *in the body*; the new model owns them in a
   server-only envelope. Since `beforeWrite` is body-only and idempotent (§6), running it over
   stored docs surfaces every record that isn't a fixed point (§6.3) — the reshape (lift legacy
   provenance out of the body into the envelope) becomes a *discoverable* migration, lazy on next
   write or a batch pass, rather than a silent one. Idempotence is what constrains *what can change
   and where*.

## Capabilities & enforcement (resolved 2026-08)

- **Baseline enforcement is token pass-through — and it ports directly.** Today `getUserRoles(req)`
  resolves the caller's roles from the request token, and `getMethodAccess` applies RBAC, in both
  `doc.ts` and `docs.ts`. The universal/procedure path reuses *exactly this*: a procedure's store
  capability is bound to the **caller's token**, so its sub-requests re-enter the same
  `getUserRoles` + `getMethodAccess` check. **The only new work is propagating the caller's token
  into procedure sub-requests** — the enforcement code itself is a port. *Runnable reference:*
  `store-capability.ts` (+ tests) binds a capability to a principal and shows a procedure reads
  *identically* to a direct call over the real `getMethodAccess`.
- **Everything beyond the caller's rights is an injected capability** (LLM, storage, …), gated by
  presence/absence in the evaluator's cap set.
- **Crown jewels — enforce directly, never reachable by caller / procedure / `beforeWrite`:**
  **auth-affecting** caps (change a principal's identity/roles) and **rule-changing** caps (install/
  modify rules, schemas, access config). Both can rewrite the authorization system itself. Because
  auth/rule records are documents, they are governed by **both** their hardwired capability gate
  **and** the ordinary `/doc` collection RBAC on top (AND-composed) — the outer layer can only
  further-restrict, e.g. a users-collection read projection that hides other users' personal fields.
- **First build/test step: a toy capability.** A trivial injectable op is the fixture for the
  capability-gate invariants (§9.1/§9.2/§9.10) — proves present ⇒ usable, absent ⇒ VM-denied —
  before any real capability (or the crown jewels) exists.

## Ports cleanly (low risk)

tosijs-schema validation · `getUserRoles`/auth · path parsing (`getRef`, `collectionPath`) · the
role hierarchy + precedence semantics · row-level read masking (→ `isReadAllowed`) · `/gen` &
`/stored` as batteries. These are the trusted core the ROADMAP says survives.
