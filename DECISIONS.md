# Decisions

Numbered, dated, self-contained architectural decisions. **ROADMAP.md is a plan and will be
rewritten; this file is a ledger and is append-only.** When a decision is superseded, the entry
stays and gains a `Superseded by` line — the reasoning is worth more than the conclusion, and a
retracted decision that vanishes teaches nobody.

Each entry names **where it lands**, because several of these constrain repos that do not exist yet
(`tosijs-blog`, `tosijs-assets`) or belong to another leg (`tosijs-ui`, `tjs-lang`). At extraction
time, carry the entry with the code.

| # | decision | lands in |
|---|---|---|
| [D1](#d1) | Three legs; this repo is the service layer | all |
| [D2](#d2) | ajs rules stay pure predicates; transforms → ajs once the host exists | this repo |
| [D3](#d3) | The real root of trust is datastore access | this repo |
| [D4](#d4) | `owner`/`super` add authority over rules, not power | this repo |
| [D5](#d5) | Access is a lattice: boolean visibility × schema projection | this repo |
| [D6](#d6) | Field-level access is a schema, not a field map | this repo |
| [D7](#d7) | Filter before limit | this repo |
| [D8](#d8) | Route contributions replace prefetch/sitemap endpoints | this repo + tosijs-ui + components |
| [D9](#d9) | Libraries as a service vend docs/examples/LLMs.txt | this repo + tosijs-ui |
| [D10](#d10) | SSR is public | this repo + every route contributor |
| [D11](#d11) | One definition of "published" | tosijs-blog |
| [D12](#d12) | Endpoints self-gate on their own tests | this repo |
| [D13](#d13) | Build on demand; validate the design against what is unbuilt | all |
| [D14](#d14) | Collections are data; no compiled authority, not even for owner | this repo |
| [D15](#d15) | Namespaces use `:`; a manifest may declare only its own | this repo |
| [D16](#d16) | Bootstrap by proving datastore access, not by a first-run secret | this repo |
| [D17](#d17) | Install v1 is declarative; `functions` is refused, not ignored | this repo |
| [D18](#d18) | Consumer order: virta, then the tjs-lang platform, then loewald.com | all |

---

## D1
**Three legs; this repo is the service layer.** *(2026-09-10, with tjs-lang)*

tosijs-ui owns build/docs/SEO. tjs-lang owns the transpiler, language and VM. **This repo owns the
service layer**, and its core value is *RBAC · the universal endpoint · the data layer · stored
functions with versioning and tests*. The blog and asset manager become separate front-end libraries
on tosijs-ui — separate projects, not subdirectories.

**Consequence:** `src/blog.ts`, `src/asset-manager.ts` and the editors are not this repo's product.
Work on them is migration preparation, not investment.
**Lands in:** all three repos. → ROADMAP "Three legs".

## D2
**ajs rules stay pure boolean predicates; transform/field-strain/provenance/unique stay compiled
TCB.** *(2026-09-05, Phase 0)*

The alternative — rules returning transformed `newData` — is exactly the shape
[tjs-lang#52](https://github.com/tonioloewald/tjs-lang/issues/52) corrupts silently: a `beforeWrite`
returning `{...data, revisions}` persists `{revisions}` alone. Data loss with a plausible payload.

**Correction (2026-09-06):** the original claim that predicates are "entirely unaffected" by #52 was
**false and fails open** — [tjs-lang#54](https://github.com/tonioloewald/tjs-lang/issues/54).

**SUPERSEDED (2026-09-12): transforms move to ajs. Blocked on the ajs host, not on a decision.**

#52 and #54 were fixed in 0.13.12 (verified; the tripwires fired and became regression cases), so
the *only* argument for compiled transforms — that ajs silently corrupted them — is gone. Recorded
first as "open for revisit", which was wrong: on inspection nothing argues for keeping them compiled
as a permanent choice, and two things argue against it.

- **§6.1 requires it.** "Policy is not a sidecar" is unsatisfiable while transforms ship with a
  deploy: a client cannot pin a policy version that lives in compiled code. Deploy atomicity depends
  on the transform being part of the versioned endpoint artifact.
- **Blast radius was the counter, and D12 answers it.** A procedure that cannot install unless its
  own tests pass is a stronger gate than `tsc` plus review.

So this is a **settled direction awaiting a prerequisite**, not an open question. The prerequisite is
the ajs host; until it exists, transforms stay compiled because there is nowhere else to put them.

Residual: [#56](https://github.com/tonioloewald/tjs-lang/issues/56) (bare context bindings still
return their own name) — neutralised at our boundary by interpreting rule results as
`result === true`, never `!!result`.

When the port happens: the rule half must also honour
[D13](#d13)(c) — meta-authority operations are unreachable from a procedure (now written into
`UNIVERSAL-ENDPOINT.md` §4.3).
**Lands in:** this repo. → `tjs-lang.baseline.test.ts` §5–§6.

## D3
**The real root of trust is datastore access, not a role we design.** *(2026-09-06)*

Certain IAM roles read and write Firestore with no reference to our endpoints. That is the true root,
it exists by construction, and inventing an out-of-band authority (an earlier draft proposed Firebase
custom claims — **retracted**) would create a second root beneath an existing one.

Two consequences: the break-glass path already exists (and is how the first `owner` is seeded), and
our invariants defend against escalation **through the API only** — never against project-level
access. State that scope plainly.
**Lands in:** this repo. → ROADMAP "Meta-authority".

## D4
**`owner` is the in-system reflection of the Firestore account holder; `super` and `owner` add
authority over the rules, not power over the site.** *(2026-09-06)*

`developer` is already effectively total access (module write ⇒ arbitrary JS via `/esm`), so there is
nothing functional to grant above it. `super` = developer + may write `role`/`config`. `owner` =
super + exclusively adds/removes `super` and transfers `owner`. Neither may assign or remove
`owner`/`super` — that is owner-only.

Circularity is broken by **monotonicity: no write may increase the writer's own authority.**

**Insufficient as stated — see [D13](#d13)(c).** That formulation holds for direct writes and fails
for deferred ones: a procedure installed by a `super` and invoked by an `owner` runs with owner
authority, so it can mint a `super` without its installer ever having raised their own authority.
The correct statement is that monotonicity must hold over the **composition**, and the intended fix
is that meta-authority operations are unreachable from a procedure.

**FIXED AND DEPLOYED 2026-09-12.** `role.ts` is owner-only; the escalation chain is severed at step
one. The privilege-lifecycle tripwires flipped on contact and now assert the denial. Monotonicity
itself — a `super` not being able to mint a peer — still needs D12's `isWriteAllowed`, and D13(c)
records that it must hold over *deferred* execution too.

**Demonstrated 2026-09-11**, no longer inferred: `privilege-lifecycle.integration.test.ts` §12–13
drive it end-to-end — an admin writes the role collection, self-grants `developer`, and the new role
is live on the very next request. Those tests assert the CURRENT (wrong) behaviour deliberately, so
the suite flips the day `role.ts` moves to owner-only.

**Also found by the same file:** removing a uid from `userIds` is **not revocation**. `getUserRoles`
writes during a read — when the uid lookup misses it matches `contacts` by email and *re-appends the
uid*. The grant is still real (roles and contacts are unchanged), so this is an operator footgun
rather than an authorization bug: revoking means clearing `roles` or removing the contact, never just
the uid.
**Lands in:** this repo. → ROADMAP "Meta-authority".

## D5
**Access is a lattice on two independent axes.** *(2026-09-06)*

`AccessFilterFunc` conflated row visibility with field projection, which is why role combination had
no defined join. Split them:

| axis | value | join across roles | top |
|---|---|---|---|
| row visibility | boolean | OR | `true` |
| field projection | schema | union of properties | `ALL` |

Replaces the accidental rule, where precedence came from object-key order in each collection's
`access` literal and a later entry *replaced* an earlier one — so holding more roles could grant
less (demonstrated).

**Audit:** every production `AccessFilterFunc` is already a predicate returning the document
unchanged; only the emulator-only demo fixture projects. So the split is nearly free.

**Incomplete as stated — see [D13](#d13)(b).** This lattice covers the **document** axis only. It has
no notion of a *capability* (migrations, storage, `/gen`, third-party APIs), which is
role × capability → permitted invocation *and arguments*. Do not cite D5 as a complete access model
until that third object type is designed.
**Open:** union over schema *constraints* (`min`/`max`/`pattern`) is not obviously "most permissive".
**Lands in:** this repo. → ROADMAP "The access lattice".

## D6
**Field-level access is a schema, not a `FieldAccessMap`.** *(2026-08, re-affirmed 2026-09-06)*

Schema is guard *and* strainer, and it is type-sound. Critically it resolves the write case: a write
field map would have to **silently drop** fields the author submitted, whereas a write **schema
rejects** them, because tosijs-schema is strict about unexpected properties.

**Interim:** non-`ALL` write configs currently **deny** (fail closed) because the write path never
applied them. That is scaffolding until write-schemas land.
**Lands in:** this repo. → `UNIVERSAL-ENDPOINT.md` §178, TODO F1.

## D7
**Filter before limit.** *(2026-09-06)*

`.limit(n)` ran before the visibility filter, so a request for 10 published posts could return 3
while 50 existed. Asking for n and getting fewer, with more available, is a wrong answer. Paging
until n visible rows is right; if that becomes a performance problem, that is for later — assuming
it is one is premature optimisation.

Bounded by `MAX_FILTER_SCAN`, and **exceeding the bound logs** rather than silently truncating,
because "we stopped looking" and "there is nothing more" must not look alike. Projection happens
*after* filtering (projecting first stripped the field the predicate reads).
**Lands in:** this repo. → `docs.ts`.

## D8
**Prefetch and sitemap stop being endpoints; they become route contributions.** *(2026-09-10)*

A component registers a stored function and the platform invokes it for routes it claims. The blog
provides a prefetch handler for routes matching its idea of a blog route; any component contributes
sitemap entries.

| concern | owner |
|---|---|
| routing, deciding what needs SSR, JIT-vs-static | tosijs-ui |
| hosting, invoking and caching contributed functions | this repo |
| the handlers themselves | the component |

**Why structural, not tidy:** the 2026-09-06 sitemap bugs were *drift* bugs — `sitemap.ts` had its
own notion of "published" and its own notion of the host, both wrong. A contributing component has
only one notion, so there is nothing to drift from.
**Lands in:** this repo (mechanism), tosijs-ui (routing), each component (handlers).

## D9
**Libraries as a service: the same mechanism vends doc pages, examples and LLMs.txt.**
*(2026-09-10)*

A library shipped through the platform contributes its documentation surface as routes backed by
stored functions. With `/esm` already serving modules from Firestore, a library becomes **wholly
data** — code, docs, examples and tests, stored and versioned, served with no deploy. Composes with
D12: a library version whose tests fail should not become servable.
**Lands in:** this repo (mechanism), tosijs-ui (authoring/build).

## D10
**SSR is public.** *(2026-09-10)*

The point of SSR is SEO, not speed — the site is fast, lean and cache-friendly without it, and
authenticated users get the hydrated SPA. So server-rendered output is by definition the public view.

This **retires** the "authority in the read/cache key" question rather than solving it: there is no
per-principal SSR, so no cache needs an authority key.

**Enforced structurally**, at `getPrefetchData`'s single invocation point via `asPublicRequest`, so a
contributed handler cannot render privileged content whoever wrote it. It was reachable before:
`blog.ts` built its post pools with the caller's roles and wrote them to `config/blog-cache`, which
is publicly readable, while `author`/`owner` hold `list: ALL` on `post`.
**Lands in:** this repo (enforcement) + every route contributor (D8).

## D11
**One definition of "published", shared by client and server.** *(2026-09-06)*

`unpublish()` writes `date = ''`; the server's list guard tested `date !== undefined`. `'' !==
undefined` is true, so **57 production drafts were served to anonymous callers**. Three things mean
"empty" here — `undefined`, `''`, and a *boxed tosijs proxy scalar* (an object, therefore truthy) —
and code kept picking one.

`isPublished()` in `functions/shared/post.ts` coerces with `String(v ?? '').trim()`, plus an
`UNPUBLISHED_DATE` sentinel so the written value and the tested value cannot drift. Deliberately
**not** a parseability check: a mistyped date should render oddly, not silently unpublish a live post.

**Related decision:** drafts are **unlisted, not secret** — public `read` on `post` is intentional so
a draft can be shared for comment. The property to protect is *not findable by accident*, which is
why the sitemap must exclude them (it was advertising all 57).
**Lands in:** tosijs-blog. Carry `isPublished` with the blog code.

## D12
**Endpoints self-gate: a stored procedure ships with its own tests and cannot install if they fail.**
*(2026-09-05, elevated 2026-09-10)*

Because a procedure is data, its tests are data too — they version together, with no CI-vs-prod gap.
Because ajs is deterministic with injectable (mockable) capabilities, those tests are pure and
runnable **server-side at install time**. So the server can refuse a procedure whose own tests fail:
a gate inside the install path cannot be skipped at 11pm.

D1 elevates this from a nice property to **stated core value** ("stored functions with versioning
and tests") — it is what a plain Cloud Function cannot offer.

**Caveats to design against:** the gate proves "its own tests pass", not correctness (so §6.1's
*generated* property tests matter more than author-written ones); install-time execution runs author
code and needs its own fuel/quota budget or installing is a denial-of-wallet vector; and mocked
capabilities mean the gate verifies logic, not integration, so the mocks belong to the platform's
trusted surface.
**Lands in:** this repo. → ROADMAP "Self-gating endpoints".

## D13
**Implement only what is needed, when it is needed — but validate the design against the pieces that
are not built yet.** *(2026-09-12)*

The two halves are load-bearing together. Building ahead of evidence is the error the sovereign
analysis argues against; designing without the unbuilt pieces in mind is how a model gets a shape
that cannot express them, discovered at the point where changing it is expensive.

So: no sockets, no rooms, no capability system today. But the RBAC model and the architecture get
checked against them *now*, while a change costs a paragraph rather than a migration.

**First validation pass, 2026-09-12** — checking the current design against sockets, rooms,
migrations, stored procedures and third-party capabilities. Two gaps and one defect found:

**(a) `COLLECTIONS` registers only at import time, so ephemeral collections are unrepresentable.**
*(Closed by [D14](#d14), 2026-09-19 — the registry resolves configs from data, and [D15](#d15) gives
the access model the namespace this paragraph asks for. The prediction was exact.)*
Every collection is a module-scope assignment (`COLLECTIONS.post = {…}`). Rooms (§D-games) and
§7.4's test fixtures both need *runtime* registration. The access model itself is fine; the
**registry** is not — and B3 proved registration is security-relevant, since a demo collection with
`write: ALL` for `public` shipped to production. §8 already requires that an ephemeral backend's
capabilities be "scoped to only its own ephemeral collections — an invariant, not an emergent
property", and a flat global namespace cannot express that. **Implication:** ephemeral collections
need a *namespace the access model understands* (e.g. a hard `ephemeral/<owner-id>/…` prefix rule),
so the scoping is structural rather than a convention someone has to honour.

**(b) The access model has no notion of a capability at all.** It is role × collection × method →
access. Migrations (§7.3's deliberately unusual widen-scope-keep-validation shape), storage, `/gen`
and third-party APIs are all role × **capability** → permitted invocation *and permitted arguments*.
So **D5's lattice is incomplete as stated**: it describes the document axis only. It should either
say so explicitly or grow a third object type. Not urgent — nothing ships on it — but the lattice
should not be cited as complete.

**(c) DEFECT — monotonicity does not survive deferred execution.** D4 states "no write may increase
the writer's own authority", which holds for direct writes. A stored procedure (D12) is a write
*now* that executes *later*, and §2.1 says procedures run with the **caller's** capabilities. So a
`super` may install a procedure that writes to `role`; when an `owner` invokes it, it runs with
owner authority and can mint a `super` — which D4 says only an owner may do. The installer never
increased their own authority, so monotonicity as written is satisfied while the property it exists
to protect is defeated. Classic confused deputy.

*Fix — chosen 2026-09-12 and written into `UNIVERSAL-ENDPOINT.md` §4.3.* The cheapest option: meta-authority operations
(mutating `role`, `super`, `owner`) are **not reachable from a procedure at all**; they require a
direct, attributed write. That keeps D3's "root acts through the paved path" while removing the one
place deferral is dangerous. The alternatives — intersecting caller and installer capabilities, or
refusing to invoke a procedure you cannot read — are more general and more restrictive, and can be
revisited if a case demands them. **The general statement to adopt:** *authority to install is not
authority to execute, and monotonicity must hold over the composition, not over each write
separately.*

**Also noticed:** the join over *constraints* is one open question wearing two hats — schema
projection union (D6) and capability-argument union (b) are the same problem. Solve once.
**Lands in:** all repos (the discipline); this repo (the three findings).


---

## D14
**Collection configuration is DATA, resolved through the privileges model. Nothing about what a host
can do is fixed outside the system — except owner authority, which is outside our control anyway.**
*(2026-09-19, owner)*

`COLLECTIONS` was a module-level map populated by import-time side effects, so a host's capabilities
were fixed at build time. An install system cannot exist on top of that: a collection has to be
definable by writing a document.

Consequences, in order of how much they change:

**There are no platform collections, only installed ones.** The registry makes no distinction
between `post` and `virta:task`; bare names simply belong to the platform's own namespace. This
collapses "dogfood the blog as a manifest" from a milestone into the normal case — there is no other
case.

**No compiled authority, including for `owner`.** There is deliberately no `owner ⇒ ALL` escape
hatch anywhere. Owner's real power is datastore access (D3), which lives outside anything this code
can grant or revoke, and this ledger already retracted one design (Firebase custom claims) for
inventing an in-system second root. A compiled bypass would be exactly that. So an empty or
unreadable config store **fails closed**: every collection undefined, `/doc` denies everything, and
the only way back is the datastore — which is the recovery story D3 already describes.

**The bootstrap is not circular.** Reading configs is a privileged *internal* read, not a `/doc`
request, so it is not governed by the configs it fetches. Not a new mechanism: `getUserRoles` has
always read `role` this way. Internal reads are infrastructure; the access model governs external
requests.

**One bad config must not take down the host.** Configs compile independently and a failure is
isolated to its own collection. Otherwise a typo becomes an outage — and anyone who could get one
malformed document stored could deny the entire service.

**Invalidation has to actually take effect.** `invalidate()` alone clears only the instance that
handled the request; every other instance keeps serving the old rules until its TTL expires, which
for a revocation is precisely the wrong failure. Hence a cheap `epoch()` probe: each instance
re-checks one small value every few seconds and reloads only when it moved. Rules propagate in
seconds. **Identity revocation does not** — `verifyIdToken` is still called without
`checkRevoked: true`, so an already-issued token outlives a revoked role by up to an hour. You can
change what anyone may do almost instantly; you cannot yet instantly stop being someone.

Still outside the data model and still to move: `ROLES` is a closed const, and `PRIVILEGED_ROLES`
(who sees real errors rather than opaque 404s) is a hardcoded list that is already stale —
`configurator` is missing from it.

---

## D15
**A namespace is separated by `:`, and a manifest may declare only its own.** *(2026-09-18)*

`/` was the obvious separator and is wrong: it is already the sub-collection separator.
`collectionPath()` splits document paths on `/` and keeps the even segments, so `virta/task` is
indistinguishable from "sub-collection `task` of collection `virta`" — pinned as a test, because the
collision is silent rather than an error. `:` rides inside one segment, so path parsing, `/doc?p=`,
`/docs?p=` and sub-collections all work unchanged, and it is legal in a Firestore collection id and
in a query value.

The gate has two independent rules: **any bare name belongs to the platform** — not merely the names
on a known list, so adding a platform collection later needs no edit here — and a namespaced name
must match the declaring manifest. Near-miss namespaces (`virta` vs `virta2`) are refused explicitly,
since prefix confusion is how such checks usually leak.

`role` and `module` are the ones that matter: whoever writes `role` rewrites the input to their own
authorization (D4), and `module` documents are served as executable JavaScript by `/esm`. Either
claimed by a manifest is a site takeover, not a name clash.

Logical→physical mapping is the identity function today and exists anyway, so a substrate whose
naming rules differ (Postgres table names cannot contain `:`) is a change in one file.

---

## D16
**A fresh host bootstraps by proving datastore access, not by holding a first-run secret.**
*(2026-09-19)*

The obvious design hands the deployer a secret at first boot. It has a leak window, a
who-holds-it-in-CI problem, and no recovery story once lost.

Instead: the endpoint publishes a **nonce** at an unauthenticated GET; the claimant writes it into a
designated document **directly in the datastore** (console, gcloud, psql); the endpoint compares,
mints `configurator`, rotates the nonce and clears the proof.

Nothing secret is published. The proof is not *knowing* the nonce — it is being able to **write** it
where only the datastore holder can write, and `firestore.rules` is deny-all so no API path reaches
that document. It is therefore re-runnable, which doubles as break-glass recovery, and
substrate-portable, since "console access" becomes "a psql prompt" without changing the ceremony. It
is D3 made operational rather than an authority we invented.

**Rotation is load-bearing.** Without it the proof stays in the datastore and the next authenticated
caller claims for free, converting a one-time ceremony into a standing back door.

Failure directions chosen deliberately: an absent or unparseable `issuedAt` counts as **expired**
rather than fresh; an empty proof does not match an empty nonce; an unauthenticated claim is refused
because a grant must be attributable. Comparison is a plain `===` on purpose — a timing oracle leaks
the nonce, and the nonce is published.

`configurator` is a separate role, not folded into `owner`: a host can then delegate "may install
libraries" without handing over the data, and an install appears in the ledger as its own act. It
cannot appoint another configurator, because `role` is owner-only (D4).

---

## D17
**Install v1 is declarative. A manifest carrying `functions` is REFUSED, not ignored.** *(2026-09-18)*

A manifest carries schemas, an access lattice, unique constraints, derive ops and capability
requests — all serializable. No stored ajs: tjs-lang is a validated but unwired dependency, and
tjs-lang#52/#54 corrupt transforms *and* predicates silently while upstream coerces a corrupted
result to a GRANT. Shipping caller-authored code on that is not a trade worth making.

Refusing rather than ignoring matters: silently dropping the executable half of someone's manifest
and reporting success is the worst available outcome.

Two measured tosijs-schema defects shape the format, and neither is guessable by a manifest author:

- **`$predicate` fails OPEN and is invisible to the gate.** With no evaluator registered it accepts
  anything, and because it is *in* the enforced keyword set `unenforcedKeywords()` returns `[]` for
  it. Refused by name, at any depth. This is the one that could be weaponised deliberately: a schema
  that looks validated and validates nothing.
- **`contains` is accepted but not enforced**, which is precisely the rule `page` and `module` use
  for row visibility. So visibility **cannot** be a schema; it is a small closed predicate vocabulary
  instead. That one *is* caught generically.

Transforms are a closed registry of parameterised ops (`slug`, `shortId`, `now`, `principal`,
`constant`) plus `envelope.version.bumpOn`. The manifest *selects* a transform; it never carries
code. `bumpOn` removes a bug class rather than a bug: the caller cannot send the revision field, so
the hand-written branch that once erased a module's history has nowhere to live.

An unknown visibility op **denies**, and `all: []` is refused — a predicate nobody understands, or a
vacuously true one, must never read as permission.

---

## D18
**Consumer order: virta first, then the tjs-lang platform backend, then loewald.com.** *(2026-09-19,
owner)*

Supersedes the earlier "blog first" ordering, which argued the blog is the better first customer
because it has a known-correct oracle and cannot be bent to fit a weak format.

That reasoning was about *format validation*; it ignored *risk*. loewald.com is a live site with a
decade of real data, so it is the worst place to learn what the install system gets wrong.
**tosijs-virta is greenfield — there is nothing to lose.** It is the guinea pig: unblock it
completely, let it try to get real work rolling, expect immediate adoption pain, and patch rapidly.

The **tjs-lang platform backend** is then the second consumer — languages-as-a-service,
blueprints/components-as-a-service, libraries-as-a-service, unbundled development. It is *lower risk
and higher demand* than loewald.com, which makes it a better second adopter than the blog on both
counts.

loewald.com comes last, after two consumers have shaken the design out, and is migrated to discrete
pieces rather than converted in place.

Immediate consequence: **the `/doc` swap for platform collections is NOT on virta's critical path.**
Installed collections are what virta needs; `post`/`page`/`module` can stay compiled until their
turn. A production-touching migration was about to be done for a consumer that does not require it.
