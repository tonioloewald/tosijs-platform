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
| [D2](#d2) | ajs rules stay pure predicates; transforms stay compiled TCB | this repo |
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
**false and fails open** — see D3's neighbour, [tjs-lang#54](https://github.com/tonioloewald/tjs-lang/issues/54).
The decision stands; the reasoning changed.
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

**Open / not yet implemented:** `role.ts` still grants `ROLES.admin` `write: ALL`, which is the whole
escalation chain (admin → self-grant developer → arbitrary JS). One-line fix available now
(`[ROLES.admin]` → `[ROLES.owner]`); production currently has no admin, so it is preventive.
Monotonicity itself needs D12's `isWriteAllowed`.
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
