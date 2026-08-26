# Universal Endpoint: Doc / Docs / Procedures — Design

> Detailed backend design for the universal endpoint described in
> [ROADMAP.md](ROADMAP.md) (backend consolidation). This is the concrete form of
> the ajs/security design that ROADMAP.md marks as "grounded on tjs-lang 0.13.1,
> re-validate before building." It **supersedes** the roadmap's earlier single
> "typed discriminated-union write outcome" idea with the two-stage
> `beforeWrite` + boolean `isWriteAllowed` split below.

Status: design for implementation of the general case. Backend-agnostic. Firestore is the first backing store, not the reference semantics.

## 1. Architecture

The server is a static runtime. It does not change when the application changes.

```
client (tosijs-ui, unbundled tjs modules)
   │
   ▼
universal endpoint (ajs VM, capability injection, fuel)
   ├── doc / docs        read, query, write against a document store
   ├── procedures        stored, versioned ajs, executed with caller's capabilities
   └── ssr               render + cache HTML for dynamic routes (out of scope here)
   │
   ▼
capabilities (doc store, auth, LLM, storage, ...)  ──  backed by Firestore / Postgres / etc.
```

Application logic lives in three places, all in ajs, all evaluated by the same VM:

| Artifact   | Bound to | Runs with                       | Returns                  |
|------------|----------|----------------------------------|--------------------------|
| procedure  | name     | caller's capabilities            | shaped result            |
| beforeWrite | path     | caller's capabilities            | rewritten document body  |
| isWriteAllowed | path     | privileged read, **no write**    | `true` / `false` only    |

Firestore security rules are not used. Authorization is defined by path and the artifacts above, identically for every backend and every entry point (doc, docs, procedure) — because all three carry the **same caller token** into the **same RBAC check** (§2.1).

## 2. Trust model

1. **No amplification in procedures — enforced by token pass-through.** A procedure runs with exactly the caller's capabilities because the store capability it is handed is bound to the **caller's request token**: every doc/docs read or write it performs re-enters the same RBAC check under the caller's identity, exactly as if the caller had made the request directly. The direct `/doc` path and the universal/procedure path are the same enforcement on the same token — there is no elevated credential to amplify with. A procedure is cached, pre-validated, nameable request-as-code and nothing more.
2. **Amplification exists in one place: `isWriteAllowed`.** It holds privileged read so it can check invariants over documents the caller cannot read. It holds no write capability and can return only a boolean. This privileged read is the one credential that is **not** the caller's token — system-provided to system-owned rule code, which is exactly why it is boolean-only and write-less. Enforce this in the capability set handed to the evaluator, not by convention.
3. **Split by what a stage may do:** anything that sees privileged data cannot write; anything that writes cannot see privileged data.
4. **Fuel exhaustion in `isWriteAllowed` is a deny.** Any question the rule cannot finish answering is answered NO.
5. **Installing `isWriteAllowed` rules is the most privileged write in the system.** Procedures and `beforeWrite` transforms cannot install or modify rules.
6. **Beyond the caller's token, power comes only from injected capabilities** (LLM, storage, …), each enforced by its presence/absence in the evaluator's cap set. Two classes are the crown jewels and must be enforced **directly** — never reachable by caller code, a procedure, or `beforeWrite`: **auth-affecting** capabilities (anything that changes a principal's identity or roles — i.e. can redefine who the RBAC check sees) and **rule-changing** capabilities (installing/modifying rules, schemas, access config — §2.5). Both can rewrite the authorization system itself, so holding either *is* the true privileged boundary. Because auth records and rules are themselves **documents in collections**, they are governed by **both** their hardwired capability gate **and** the ordinary `/doc` collection RBAC layered on top — **AND-composed, both must pass**. The outer layer can only *further restrict*: e.g. a read projection on the users collection stops one class of user from reading another user's personal fields, independent of any auth capability. A **toy capability** (a trivial injectable op) is the first test fixture: it lets the §9 gate tests (present ⇒ usable, absent ⇒ VM-denied) run before any real capability exists.

## 3. Write pipeline

Every write, whether from doc/docs directly or from a procedure, passes through the same pipeline. Procedures do not get a shortcut.

```
proposal (caller)
   │
   ▼
beforeWrite      per touched document; caller caps; body only; pure; idempotent
   │
   ▼
no-op check      normalized body == stored body  →  no write, no stamp, return
   │
   ▼
isWriteAllowed   whole transaction; privileged read; boolean
   │
   ▼
commit           endpoint stamps envelope (savedAt, version, author, ...)
```

Ordering is a security property: `isWriteAllowed` sees what will actually land, so a transform cannot launder a write past a rule.

## 4. Stage contracts

### 4.1 `beforeWrite`

- Input: the caller's proposed body for one document, the caller's capabilities, an **injected clock**.
- Output: the body to store.
- Sees nothing the caller could not see. No privileged read. No write capability. It cannot touch other documents.
- Pure and deterministic given its inputs. `Date.now()` and other ambient state are not available; time comes from the injected clock.
- **Idempotent — expected and tested, not enforced.** `beforeWrite(beforeWrite(x)) == beforeWrite(x)` for every schema-valid `x` is a property the generated test (§6.1) checks per path. The runtime does **not** police it and does not "protect `beforeWrite` from itself" (no frozen inputs, no re-run-to-verify, no rejection of non-idempotent transforms). A non-idempotent transform is an author bug — made visible by that test and the §6.3 fixed-point health check, and bounded in cost (redundant writes) — not something the system prevents.
- Does not generate timestamps. It may normalize caller-asserted timestamps (coerce format, clamp to injected now, reject the future) because those are caller data.
- Does not receive envelope fields and therefore cannot write them.

### 4.2 `isWriteAllowed`

- Input: the principal, the **entire proposed transaction** as before-state and after-state for every touched document (post-`beforeWrite`), a privileged read capability, fuel.
- Output: `true` or `false`. Nothing else. No error payloads that carry data.
- No write capability of any kind.
- Fuel exhaustion, thrown error, or non-boolean return all evaluate as `false`.
- Must see the whole write set, not one document at a time. This is what makes cross-document invariants ("debit equals credit", "message appended to another user's inbox") expressible as short rules rather than escape hatches. Per-document evaluation is explicitly rejected.
- Does not run per-document in a loop; it is invoked once per transaction with the full set.
- **Uniqueness lives here.** The rule uses its privileged read to detect a collision and returns `false`. Because it cannot mutate, it can only *reject* a missing or duplicate unique value — it cannot mint one; minting/deriving a unique value (where RBAC permits) is `beforeWrite`'s job. Soundness under concurrency relies on the transactional commit (§3); an index-backed uniqueness constraint is the fast path where the backend offers one.

### 4.3 Procedures

- ajs, stored as documents, versioned.
- Executed with caller's capabilities. Every write they perform goes through §3.
- Old versions are retained; infrastructure cost is zero. Non-infrastructure cost is not zero, so invocation of every procedure version is logged so legacy use is visible and can be retired deliberately.
- Procedures should declare the schema version they were written against. A procedure whose schema is gone fails loudly rather than running against a shape it does not understand.

## 5. Body vs envelope

The line is drawn by who asserts the field, not by which stage touches it.

| Kind             | Examples                          | Where       | Who writes                | Trust      |
|------------------|-----------------------------------|-------------|---------------------------|------------|
| caller-asserted  | content, `editedAt`, client IDs   | body        | caller, then `beforeWrite`  | untrusted  |
| server-asserted  | `savedAt`, `version`, `author`, `createdAt` | envelope | endpoint at commit | trusted    |

- `beforeWrite` receives and returns body only. Envelope is unreachable from user-authored ajs; forgery of provenance is structurally impossible.
- The no-op check compares body to body. Envelope fields are never part of the diff, so re-applying `beforeWrite` to a stored record produces no write and no new stamp.
- `editedAt` (caller's claim of when they edited) and `savedAt` (server's fact of when it landed) are distinct fields and are not conflated.

## 6. Idempotence as infrastructure

Idempotence of `beforeWrite` is not just retry safety. It makes stored data a fixed point of the transform, which yields:

1. **Generated property test.** For each path with a `beforeWrite`, tjs generates: for schema-valid `x`, `beforeWrite(beforeWrite(x)) == beforeWrite(x)`. Same mechanism as the existing implicit tests.
2. **No-op write detection.** Re-submitting a stored record is free and stamps nothing.
3. **Data-health / migration discovery.** Running `beforeWrite` over stored documents and reporting those that are not fixed points finds every record that predates the current rule. A rule change becomes a discoverable migration instead of a silent one.
4. **Replay determinism.** Sequenced-replica and optimistic-concurrency paths re-run the transform and get the same transaction.

Idempotence is a **tested expectation, never a runtime guard.** We do not freeze inputs, re-run to verify, or reject a non-idempotent transform — the generated test (1) and the health check (3) make a violation *visible*, its cost is bounded (redundant writes), so runtime enforcement would buy nothing.

## 7. Query semantics

- The doc/docs endpoint owns query semantics. The backing store is an oracle that is fast or slow; it does not define what a query means. The abstraction is non-leaky by construction.
- **Postgres is the reference semantics**, not Firestore. Ordered listing, offset, multiple inequality predicates, and the join in §7.1 are part of the contract; Firestore emulates them in the endpoint at whatever cost it costs. Designing to Firestore's limits would encode them into the abstraction permanently.
- On Postgres, schema-declared queryable fields become generated columns with indexes; everything else is JSONB. A field that is not a generated column cannot appear in a predicate, which makes the unindexed-query rule structural.
- **Resolved (2026-08): queries are gas-metered; an unindexed query is not a special failure.** A full scan simply burns gas fast, so it succeeds on a small collection and *exhausts gas* on a large one — "scale without thinking" falls out of the gas limiter, not a hard index rule. The failure mode is always gas exhaustion, never a bespoke "no index" error (it should not "just fail"). The endpoint *may* be stricter and pre-fail a query it can see will scan, but still attributed to gas. Indexing is the optimization that keeps a query under gas; the real cause (missing index) is recovered from the query cost log below.
- Every query shape is logged with cost, so slowness is discovered from logs and not from a bill.
- Index definitions are derived from schema declarations. On backends where indexes are a deploy artifact (Firestore `firestore.indexes.json`), that artifact is generated, not authored.

### 7.1 References and the built-in inner join

- tosijs-schema gains one keyword: `{ "type": "string", "format": "docref", "$path": "/customers" }`. A predicate cannot express this; the endpoint needs to derive from it statically.
- Derived from a reference: index on the field (both backends), `join:` support in `docs`, delete semantics, a dependency edge for delta/SSR invalidation.
- `docs(path, { join: refField })` attaches the referenced document under the reference field for each outer row. Rows whose reference resolves to nothing, or whose target fails `isReadAllowed`, are omitted (inner join).
- Semantics are defined by the emulation: collect refs, batched fetch, attach. Postgres executes it as one indexed join; Firestore as a batched `getAll` in the endpoint. Same result, different cost, both logged.
- **One hop only.** No chaining through the referenced document's own references.
- **Delete defaults to restrict.** Cascade is opt-in per reference; dangling is detectable via tombstones.
- Everything else that looks like a join is the client's job over its local replicas (§7.2) or a procedure.

### 7.2 Change propagation: pull only, versioned delta

- No subscriptions or listeners in the general case. Ambient listeners are the root of Firestore's characteristic perf collapse; the fix is to not make them free.
- Envelope carries a **monotonic per-collection sequence** (not wall-clock; two writes in one millisecond must not lose a delta) and **tombstones** for deletes. Tombstones need not be physical per-doc records — a compact per-collection list of dead ids that the `since` query consults ("virtual tombstones") works, and can be compacted/retired over time as replicas pass the watermark.
- `docs(path, { since: seq })` returns the delta. This is the client cache's replica watermark and the SSR cache's invalidation query; one primitive, two consumers.
- Client-side cache (IndexedDB, encrypted) keys should derive from the session so cached data becomes unreadable when the principal's authorization changes.
- If subscriptions are ever added, they are an explicit budgeted capability held by the endpoint (one server-side listener per distinct query shape, fanned out, `isReadAllowed` applied as a stream filter), never a client-held listener.

## 8. Residual risks (accepted, priced, not closed)

| Risk | Status | Mitigation |
|------|--------|-----------|
| Exfiltration via `isWriteAllowed` outputs | **Eliminated** | boolean-only, no write, enforced by capability set |
| Confused deputy via `beforeWrite` | **Eliminated** | caller caps only, no privileged read, body only |
| Provenance forgery | **Eliminated** | envelope unreachable from user ajs |
| One-bit oracle (probe → allow/deny leaks hidden state) | Inherent to expressive rules | token-bucket rate limit; lint: gate on existence/ownership, not on secret values |
| Timing via privileged `get()` latency | Inherent | rate limit; accept. Constant-time evaluation is explicitly rejected. |
| Unindexed scan under fuel limit | Open | §7 |

## 9. Invariants (for the implementer; each should be a test)

1. A procedure cannot acquire any capability the caller does not hold.
2. `isWriteAllowed` cannot write. Attempting to obtain a write capability inside a rule is a VM error, not a runtime check.
3. `isWriteAllowed` returns a boolean; anything else is `false`.
4. `isWriteAllowed` is invoked once per transaction with every touched document's before/after state.
5. `beforeWrite` runs before `isWriteAllowed` on every write path, including procedure-originated writes.
6. `beforeWrite` cannot read or write any document other than the one proposed, and cannot see envelope fields.
7. `beforeWrite` is idempotent over schema-valid input (generated test).
8. A write whose normalized body equals the stored body is a no-op: no commit, no stamp.
9. Envelope fields are written only by the endpoint at commit.
10. Rule installation requires a capability that procedures and transforms can never hold.
11. Every procedure invocation is logged with procedure name and version.
12. Every query is logged with shape and cost.

## 10. Open questions

- **Read authorization — resolved (2026-08).** Two independent parts. (1) **Row visibility:** `isReadAllowed`, the pure boolean privileged-read rule (same contract as §4.2), applied per result row or — better — pushed into the query as a filter so unauthorized rows never leave the store. (2) **Field-level projection = a schema.** A role's read permission is simply a (sub)schema; the endpoint strains each visible document through it. This is the whole payoff of a schema-first stack — schema is guard *and* strainer, and it is type-sound (output type = the projection schema), so no separate projection ajs is needed. Field-level *write* restriction is the mirror image: `beforeWrite` strips/rejects fields the caller may not set.
- **Offline write queue.** Delta pull covers reads. Offline *writes* (queue locally, replay through §3 on reconnect, surface conflicts by sequence) are not designed here.
- **Schema versioning for procedures:** pinning mechanism and failure mode.
- **Migration tooling** built on the fixed-point check (§6.3): report-only vs. auto-apply.
