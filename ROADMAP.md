# tosijs-platform Roadmap — backend consolidation

> Rewritten 2026-08-24. **Supersedes** the prior "ajs / universal-endpoint" roadmap (whose
> center of gravity — a server-side interpreter that *rebuilds* the content system as data —
> predated the **tosijs-ui build/dev/doc-site system**, which now owns page generation). See
> [TODO.md](TODO.md) for near-term tasks.

## The thesis (settled)

The platform's old split personality — *client behavior is data* (`/esm` modules), *server
security is code* (deploy-gated `validate`/access) — resolves not by building one big server-side
interpreter, but by **splitting the repo cleanly along the client/server line and consolidating
each half where it belongs**:

- **tosijs-ui owns the front.** Its build emits one pre-rendered `/<slug>/index.html` per known
  path (no-JS-readable, then hydrated into a client SPA), with full SEO/OG/JSON-LD/sitemap/robots
  and an **in-browser edit-source UI**. Purely build-time/client-side today.
- **This repo becomes pure backend.** All server logic consolidates here — including the backend
  half of tjs-lang's reference universal endpoint — while every client artifact moves out. The two
  repos already point at each other: tosijs-ui's `doc-system-roadmap.md` designs a pluggable
  **`DocStore`** seam (`RestStore`/`DbStore`, unbuilt) and says the hosted auth/versioning "is
  already worked out … in **loewald-dot-com** — we adopt it wholesale."

**End state:** *`tosijs-platform` (this repo) = the secured backend / universal endpoint — `/doc`,
`/docs`, and one stored-ajs endpoint — with everything else expressed as collection config or
stored ajs. Its own hosting is just a standard tosijs-ui build deployed to Firestore, served via
`/prefetch` as cached SSR HTML. Because all its unique code is backend, it becomes trivially
testable.*

**The end goal:** spin up a new project, hand it a **Firebase project name** (ultimately other
providers too), and it **deploys a complete backend as-is** — no per-site server code. Everything
else is **client-side configuration**: the universal endpoint serves any collection, and
security/validation are **schemas + ajs stored as data**. A new site = a backend deploy + client
config; nothing bespoke ever ships to the server.

Name stays **`tosijs-platform`**, repo stays put — the ambiguity that briefly motivated a separate
`tosijs-edge` project isn't real.

## Repo topology (decided)

1. **tjs-lang's actual backend stuff moves here or is eliminated.** tjs-lang stays *language + VM +
   generic batteries*; its reference `functions/` universal-endpoint layer (`store.tjs`/`rbac.tjs`/
   `schema.tjs`/`routing.tjs`) consolidates into this repo, reconciled with loewald's stronger RBAC
   (field-level access + role hierarchy + provenance + typed outcomes), or is dropped.
2. **Client-side code here moves out** — to small projects or upstream into tosijs-ui. The obvious
   breakdown: **`tosijs-blog`** and **`tosijs-assets`** (the asset manager). Generic doc/site
   behavior is already tosijs-ui's.
3. **This hosting becomes a standard tosijs-ui build, deployed to Firestore**, so `/prefetch` grabs
   the server-side-rendered / cached HTML (for SEO + load time). All unique code left in this
   project is backend → **super easy to test**.
4. **The service layer reduces to `/doc` + `/docs` + one universal (stored-ajs) endpoint.**
   Everything else — the goal is to *demonstrate* this — becomes a **collection configuration or a
   stored ajs call**.

## Division of labor

| Concern | Owner |
|---|---|
| Static page-per-path, SEO/OG/sitemap, hydration + SPA, in-browser edit UI | **tosijs-ui build** |
| Blog UI + editor | **`tosijs-blog`** (extracted from here) |
| Asset-manager UI | **`tosijs-assets`** (extracted from here) |
| `/doc` + `/docs` + universal stored-ajs endpoint; RBAC; ajs procs; batteries | **this repo** |
| Language + VM + generic batteries | **tjs-lang** (backend endpoint layer moves here) |
| The `DocStore` **contract** | tosijs-ui defines it; **this repo conforms** (decision 5) |
| Hosting HTML | a **tosijs-ui build deployed to Firestore**, served via `/prefetch` |

## Decisions taken (2026-08-24)

1. **Keep it `tosijs-platform`, in this repo.** No separate backend project, no `tosijs-edge`.
2. **Consolidate backend in; move client out** (`tosijs-blog`, `tosijs-assets`, or upstream to
   tosijs-ui) — see [Repo topology](#repo-topology-decided).
3. **This hosting = a standard tosijs-ui build deployed to Firestore**, with `/prefetch` serving
   cached SSR HTML. The site stops being bespoke; it eats its own backend.
4. **Service surface reduces to `/doc` + `/docs` + a universal stored-ajs endpoint**; prove that
   everything else is a collection config or a stored ajs call.
5. **Adopt tosijs-ui's `DocStore` interface as the contract.** Implement `RestStore`/`DbStore` to
   satisfy their seam (`readSource`/`writeSource`/`createDoc`) so it plugs in wholesale.
6. **Ground the ajs/security design on tjs-lang 0.13.1 — don't re-freeze it.** 0.13.1 is released,
   shape settled (patches possible). The prior "14 settled invariants, do not relitigate" framing
   is retired — carry that reasoning as *design intent to re-validate against 0.13.1's primitives*,
   and re-run the VM spike against 0.13.1 before building backend internals.

## Serving model

Uniform and cache-first — the same shape whether a page is precomputed or built on demand:

1. A request that looks like a page — `hostname/foo` — returns **cache-friendly static HTML**, from
   one of two sources:
   - **Directly** — a stored `foo/index.html` (the tosijs-ui build output, deployed to Firestore).
   - **Virtually** — `/prefetch` looks in storage for the cached page and returns it, or **builds
     it, caches it, and returns it**. This is where *dynamically-generated* pages live: first hit
     pays for the build, the rest are cache reads. (This is `/prefetch`'s catch-all reborn as a
     page-cache builder, **not** an SSR-data injector — the exact class of bug that took the site
     down on 2026-08-21.)
2. The returned HTML always carries **hydration stubs** — exactly how tosijs-ui pages work — so it
   reads with no JS, then hydrates into functionality in place.
3. Hydration pulls **`docs.json`** (also cache-friendly) — the corpus that drives SPA nav.
4. **Freshness via delta, not invalidation.** `docs.json` carries a **timestamp**. After loading it
   (preferably from cache), the client asks for *updates since that timestamp* and gets **nothing**,
   a **delta**, or a **whole fresh `docs.json`**. Freshness rides an incremental query, not a
   rebuild-or-purge hook.

## The bridge (`DocStore`)

Your "edit files against the service layer, then ingest on the dev side," generalized from
tosijs-ui's existing *local-FS* loop to *our service*:

- **Edit-time write-through.** tosijs-ui's in-browser "edit source" today reads/writes the repo via
  a dev-only `/__docstore/source` endpoint (chokidar then rebuilds — the build *is* the preview).
  `RestStore` redirects those reads/writes at **our** service, so authoring writes records.
- **Build-time ingest.** `config.prebuild()` (their sanctioned pre-extraction hook) pulls records
  from our service into the corpus (`docPaths`), or `extractDocs` is extended to accept a non-FS
  source. Caveat: a `prebuild` that writes into a *watched* path rebuilds forever (documented in
  their `dev.ts`).
- **Versioning & auth are ours** — records-as-source with our existing versioning + role model
  (`doc.ts`/`docs.ts` + `user.ts`). That's the piece tosijs-ui's roadmap wants to adopt wholesale.

## The payoff: zero-deploy full-stack components

Why the ajs backend earns its keep even though tosijs-ui owns page generation. A component becomes
**deployable-as-data, end to end, with no `deploy` step**:

- **Front-end code ships via `/esm`** — modules in Firestore, served as `content-type:
  text/javascript`, hot-swappable today.
- **The server-side portion of that component is written in ajs** and brought on board the same way
  — a stored proc evaluated behind the secured endpoint, no Cloud Functions redeploy.

A "component" stops being *client code you ship + server code you deploy*; it's **one artifact, both
halves data**. That's the README's "PHP/LAMP simplicity" thesis finally reaching the server tier.

## Dev loop — the Firebase emulators become obsolete

Storing an ajs endpoint is **faster than deploying a Firebase function** (or any lambda) will ever
be — a proc is *data you write*, not code you deploy. So the emulators lose their reason to exist:
the backend-logic edit/test loop becomes **store-ajs-and-run**, and unit testing is **pure and
deterministic** (mock the capabilities) — no emulator, no `functions.config()` tooling gotchas, no
rebuild-and-restart. (Until the port lands, CLAUDE.md's current emulator workflow still applies —
this is the target, not today.)

## What moves where

- **Out of this repo → `tosijs-blog` / `tosijs-assets` / tosijs-ui:** `blog.ts` + the blog/page/
  schema editors → `tosijs-blog`; the asset-manager → `tosijs-assets`; anything generic → upstream
  into tosijs-ui.
- **Into this repo (from tjs-lang) or eliminated:** the reference universal-endpoint / batteries
  layer, reconciled with loewald's stronger RBAC.
- **Dies:** `/prefetch`'s SSR-data-injection role (becomes a cached-HTML server); `sitemap.ts`
  (tosijs-ui emits `sitemap.xml`).
- **Stays as the backend core:** `/doc`/`/docs` (the substrate), the auth atom (`user.ts`), the VM
  host, hardened `gen`/`stored`, collection configs, and stored ajs.

## The ajs / security design — grounded on tjs-lang 0.13.1 (not re-frozen)

**The concrete spec now lives in [UNIVERSAL-ENDPOINT.md](UNIVERSAL-ENDPOINT.md)** (doc / docs /
procedures; the `beforeWrite` transform + boolean `isWriteAllowed` write pipeline; body-vs-envelope;
pull-only versioned deltas; Postgres-reference query semantics). That design **supersedes** the
single "typed discriminated-union write outcome" idea below with a two-stage split
(`beforeWrite` rewrites the body with caller caps; `isWriteAllowed` is a boolean rule with
privileged read and no write) — so read the invariant list below as the *pressures* that shaped it,
not the shipping contract.

Not a frozen invariant list. The prior reasoning (amoral VM + capability boundary; gas prices I/O
not just CPU; determinism → emulator-free testability; schema = intra-document vs ajs = inter-value;
provenance fields the subject can't write; authority in the read/cache key; typed
discriminated-union write outcomes; buffered/transactional capabilities) captured real design
pressure and much will likely persist **in some form** — but 0.13.1 (released; shape settled,
patches possible) reworks the VM/capability/typing model, so treat it as **design intent to
re-validate against 0.13.1's primitives**.

**Action:** ~~re-read 0.13.1's model, then re-run the VM spike~~ — **done 2026-09-05 on 0.13.11**
(see Phase 0 below). The `module.validate` oracle ports cleanly *using the #52 workarounds*, and the
rule/transform split is decided in favour of pure-predicate rules with the transform in compiled TCB.
Remaining before internals: reconcile the capability/typing model (gas pricing, buffered
capabilities) against 0.13.11's `SafeCapabilities` + `maxSourceBytes`.

## Phased plan

- **Phase 0 — baseline on tjs-lang 0.13.x. ✅ Re-run 2026-09-05 against 0.13.11.** The spike now
  lives as a test (`functions/src/collections/tjs-lang.baseline.test.ts`, 12 pass) instead of a
  scratchpad script, so the next re-validation is `bun test`. Results:
  - **Holds:** fuel metering halts a runaway rule; a zero-capability rule cannot reach I/O (fails
    closed); **boolean predicates evaluate correctly *in #52-safe shapes*** (`.includes()`, `===`,
    `!!`, bracket access, `if`-guards) — so the reference rbac rule model is workable on 0.13.11,
    **but see the correction below: it is NOT unaffected.** New in 0.13.x: a `maxSourceBytes` cap refusing oversized source *before*
    transpilation (transpiling isn't fuel-metered — a real denial-of-wallet guard for any hosted
    stored-proc endpoint).
  - **Broken upstream ([tjs-lang#52](https://github.com/tonioloewald/tjs-lang/issues/52)), silently:**
    object/array **spread is a no-op** (`{...d, c:3}` → `{c:3}`; `[...a]` → `[null]`) and
    **returning a context dot-path yields the path string** (`return doc.owner` → `"doc.owner"`).
    No error either way. Values are correct *inside* the VM (`doc.owner === user.id` → `true`);
    only the returned/derived object is wrong. Workarounds — `Object.assign({}, data, {…})` and
    bracket access — are asserted in the baseline test, as are tripwires that fail when upstream
    fixes it.
  - **This answers the §"split decision" fork** (TODO finding 4): option **(b)** "extend the rule
    contract so a rule returns transformed `newData` + a field mask" is *exactly* the shape
    tjs-lang#52 corrupts, and would corrupt it silently (a `beforeWrite` returning
    `{...data, revisions}` persists `{revisions}` alone — data loss with a plausible payload).
    Option **(a)** — transform/field-strain/provenance/unique stay compiled TCB, ajs rules stay
    pure predicates — is **far less exposed, but not immune** (see the correction). **Take (a)**,
    and treat (b) as gated on #52 plus a reason better than convenience.
  - **CORRECTION (2026-09-06, review F3 / [tjs-lang#54](https://github.com/tonioloewald/tjs-lang/issues/54)).**
    This entry originally said predicates were "entirely unaffected" by #52. **That was wrong, and
    it fails OPEN.** #52 corrupts predicates too, and upstream's `rules.tjs` ends with
    `allowed: !!result` — so a rule denying an unpublished document, written the obvious way as
    `return doc.published`, returns the *string* `'doc.published'`, which is truthy, and the rule
    **grants access**. Same for `const p = doc.published; return p` and a bare `return published`.
    Safe shapes: bracket access, `!!`, `===`, `if`-guards, `.includes()` — which is the only reason
    the original spike's cases passed. Consequences, all now pinned in
    `tjs-lang.baseline.test.ts` §5–§6: rules we author or accept must use a #52-safe shape, and
    **our host must interpret a rule result as `result === true`, never `!!result`** (§4.2 already
    requires "non-boolean return evaluates as false"; upstream simply does not honour it). The
    decision to take (a) still stands — transforms are corrupted more broadly and more silently —
    but it no longer rests on predicates being safe.
- **Phase 1 rung 1 — drop-in `doc`/`docs` parity. ✅ SHADOW PARITY VERIFIED 2026-09-06.**
  The write pipeline is extracted (`collections/write-pipeline.ts`) and shadow mode
  (`collections/shadow-compare.ts`) was run against the **live endpoint under emulators**, not
  just synthetic input. Result over a run covering POST / PUT / PATCH / no-op / rejection /
  DELETE across `post`, `module` (the revisions transform) and `page` (schema + unique):
  **14 `[shadow] match`, 3 `[shadow] expected-noop`, 0 `MISMATCH`.** That meets the cutover
  criterion recorded in `shadow-compare.ts`: zero mismatches, with `expected-noop` the only
  remaining divergence — and it is the intended §3 behaviour change (an unchanged body should
  neither write nor re-stamp; `doc.ts` today re-stamps `_modified` every time).
  - Harness: `collections/shadow-parity.integration.test.ts` (skip-guarded, prints loudly when
    it skips — a skipped test is not a passing one).
  - **Running the integration suite for the first time found three real bugs**, all invisible
    while it was skip-guarded into vacuous passes: `page` could not be written *at all*
    (`PageSchema` lacked `_created`/`_modified`, which the endpoint stamps *before* strict
    validation — the same regression fixed for `post` and missed here); `module` could not be
    *created* (`ModuleSchema` required `revisions`, which only the transform supplies, and
    validation runs before the transform); and a PUT that did not change `source` **silently
    destroyed a module's revision count**, because PUT replaces and neither `validate` branch
    assigned the field.
  - **Remaining before cutover:** decide whether to adopt the no-op behaviour change (it is an
    improvement, but it is a change), and extend parity to `config`/`role`.

- **Phase 1 — consolidate the backend.** Bring tjs-lang's reference universal-endpoint / batteries
  here (or eliminate), unify with loewald's stronger RBAC, and collapse the service surface toward
  `/doc` + `/docs` + one universal stored-ajs endpoint. Everything else re-expressed as collection
  config or stored ajs — *demonstrated*, not asserted. **Build to the
  [UNIVERSAL-ENDPOINT.md](UNIVERSAL-ENDPOINT.md) spec** (`beforeWrite` + `isWriteAllowed` pipeline,
  body-vs-envelope, versioned deltas). Port worklist:
  [UNIVERSAL-ENDPOINT-GAP-ANALYSIS.md](UNIVERSAL-ENDPOINT-GAP-ANALYSIS.md); the §9 invariants are
  scaffolded as acceptance tests in `functions/src/collections/universal-endpoint.invariants.test.ts`.
  **Acceptance ladder** (gap analysis): drop-in `doc`/`docs` parity → prefetch as a stored procedure
  → storage capability + asset-manager → *add a module editor / the blog with no function deploy*.
- **Phase 2 — extract the client.** Split out `tosijs-blog` and `tosijs-assets`; upstream generic
  bits into tosijs-ui. This repo's client shrinks to nothing unique.
- **Phase 3 — hosting eats its own backend.** Make this site a standard tosijs-ui build deployed to
  Firestore; wire `/prefetch` to serve the cached SSR HTML ([Serving model](#serving-model)).
- **Testability falls out of Phases 1–2:** once unique code is all backend and ajs is deterministic
  (mock the capabilities), the write-path oracle already here (`validate.test.ts`, `access.test.ts`,
  `write-path.integration.test.ts`) becomes the core suite — runnable **without emulators**.

## SEO (mostly resolved by delegation)

The old "SEO surrender loose ends" are largely **closed by tosijs-ui's build** — per-page
`<title>`/description/OpenGraph/Twitter/JSON-LD, plus `sitemap.xml` + `robots.txt` from the corpus,
and optional Playwright-rendered OG images. **Freshness** is handled by the `docs.json` timestamp +
updates-since-timestamp delta ([Serving model](#serving-model)), not a purge hook. Serving the build
from Firestore via `/prefetch` keeps first-paint fast and crawler-friendly.

## The backend as anchor tech — and RBAC over functions (direction, 2026-09-05)

Two framings from Tonio that change what "done" means here:

**1. This backend is *the* backend.** Not loewald.com's — to the extent any project in the ecosystem
needs a backend, it deploys this one. So it becomes **foundational, rigorous, seldom-changed anchor
tech, like `tosijs-schema`**: a small stable surface that other projects build on and rarely think
about. Consequences: (a) it is the **TCB** — the one tier where a silent wrong value is *persisted*
rather than merely rendered, which is why the fail-loudly discipline of
[tosijs-ui#61](https://github.com/tonioloewald/tosijs-ui/issues/61) is load-bearing here rather than
stylistic (Phase 0's tjs-lang#52 finding is exactly that shape: a spread bug that would have written
`{revisions}` over a whole document); (b) "seldom changed, many consumers" is the profile that
*earns* real versioning discipline — the opposite of this repo's cowboy answer on
[tosijs-coding-practices#10](https://github.com/tonioloewald/tosijs-coding-practices/issues/10),
which was argued from having exactly one consumer. Revisit that when Phase 1 lands.

**2. App-specific logic is never deployed code.** It is either an **ajs stored procedure** or a
**tjs capability installed beside** the server. Nothing bespoke ships to the server, which is the
"no function deployment" ladder restated as an architectural rule rather than a milestone.

**Where that points (not yet designed): generalize RBAC from documents to functions.** Today
`access.ts` maps *role × collection × method → permitted fields*. A capability is the same question
with a different object: *role × capability → permitted invocation* (and, by analogy with the field
maps, permitted **arguments**, not just a yes/no). Under that lens:

- **Storage is a function.** Rung 3's "storage capability → asset manager" stops being a special
  case and becomes the first non-document capability expressed in the ordinary access model —
  folding in today's bespoke `/stored`.
- `/gen` is a capability too (an expensive, rate-limited one), which is what the current
  role-gated-but-hand-rolled check in `gen.ts` is approximating.
- The role hierarchy, the precedence walk, and the field-map intersection are all reusable as-is;
  what is missing is the *object* half of the map — naming capabilities and constraining their
  arguments.

**Open:** the argument-constraint shape (is it a schema? a predicate rule? both — schema for
structure, ajs predicate for policy, mirroring §4's `beforeWrite`/`isWriteAllowed` split?); how a
capability is installed and versioned; and whether capability grants compose with document RBAC
(ROADMAP's earlier note that auth/rules "would be governed both by their own hardwired rules AND
have the `/doc` collection rules applied on top" is the same intuition).

### Self-gating endpoints: versioned, shape-enforced, shipped with their own tests

The robustness argument for the whole design, and the reason it beats deployed functions on
reliability rather than only on convenience:

**Because a procedure is data, its tests are data too.** They ship together and version together —
there is no "the tests live in CI and the code lives in prod" gap to drift through. And because
Phase 0 established that ajs is deterministic with injectable (therefore mockable) capabilities,
those tests are **pure and runnable server-side at install time** — no emulator, no network, no
build step.

That combination buys something a deployed function cannot have: **the server can refuse to install
a procedure whose own tests fail.** A gate that runs inside the write path of the thing being
installed cannot be skipped at 11pm, which is exactly the "prefer a test over a checklist" argument
from [tosijs-coding-practices#10](https://github.com/tonioloewald/tosijs-coding-practices/issues/10)
made structural instead of cultural. Composed with §4.3 (old versions retained, invocations logged)
it is also a **zero-downtime activation with no deploy**: the previous version keeps serving until
the new one passes, and a failed candidate never becomes reachable.

Layered with the boundary contract, the failure modes get small:

| layer | catches |
|---|---|
| declared input/output schemas, enforced by the endpoint (§5) | a procedure emitting a malformed shape, *regardless of what it does internally* |
| the procedure's own suite, run at install | logic the author knew to check |
| generated property tests (§6.1 idempotence) | transforms that aren't fixed points — including ones the author never considered |
| fuel + per-atom quotas | runaway cost, in VM work and in real money |
| version pinning + fail-loud on a missing schema (§4.3) | a procedure running against a shape it does not understand |

Blast radius shrinks accordingly: today a bad function deploy takes the whole backend down (we did
exactly that on 2026-08-21), whereas a bad procedure fails its own gate and never activates — and if
it somehow does, it damages one endpoint version that can be rolled back by pointing at the previous
one.

**Caveats to design against, not around:**

- **The gate proves "its own tests pass", not "it is correct."** It is a floor. Weak tests buy weak
  assurance, so the generated property tests (§6.1) matter more than the author-written ones — they
  are the part an author cannot make vacuous.
- **Install-time test execution runs author-supplied code**, so it needs its own fuel and quota
  budget, distinct from the request budget. Otherwise "install a procedure" is a denial-of-wallet
  vector — the same hazard `maxSourceBytes` addresses for transpilation.
- **A procedure whose behaviour depends on real I/O can only be tested against mocked
  capabilities.** That is the right trade (it is what makes the tests runnable at all), but it means
  the gate verifies logic, not integration — so capability mocks are part of the trusted surface and
  should be supplied by the platform, not the procedure author.

### Meta-authority: the real root is the datastore, not anything we build

*Settled with Tonio, 2026-09-06.*

**Layer 0 — outside the system, and given.** All of this lives in a data store that someone can
reach directly: in Firestore, certain IAM roles view and modify records with no reference to our
endpoints, rules or invariants. That is the true root of trust, it exists by construction, and it is
not ours to design. Two consequences we should stop working around:

- **The break-glass path already exists.** There is no need to invent an out-of-band authority
  (an earlier draft here proposed Firebase custom claims — retracted; it would have created a second
  root underneath an existing one). Ownership can always be repaired by someone with datastore
  access, which is also how the FIRST owner is established: `initial_state` seeding requires exactly
  those credentials.
- **It bounds what our invariants can honestly claim.** Everything below defends against escalation
  *through the API*. It is not, and cannot be, a defence against someone holding project-level
  Firestore access. State that scope plainly rather than implying more.

**`owner` is the in-system reflection of Layer 0** (original intent, confirmed 2026-09-06): it
denotes *the person who holds the Firestore account*, not an authority invented in the data model.
That is what makes the rest coherent — the bootstrap is self-consistent (you can only seed an owner
if you already hold the credentials that make you one), and "owner transfers owner" is tracking a
real-world fact rather than conferring a new power. Giving `owner` total in-system authority costs
nothing, because that person can bypass the system entirely anyway.

**So the intended invariant is `owner` ⇔ datastore access, and the current defect is that the
mirror can be forged from the inside.** An admin writes `role`, grants itself `owner`, and now holds
the in-system equivalent of Firestore access *without holding the Firestore account*. Read that way
the fix below is not tidying — it restores the property the design always assumed.

**Layer 1 — inside the system.** *`owner` is `developer` with special powers, and `super` is
`developer`* (Tonio, 2026-09-06). The point is that **no new capability tier is being created**:
`developer` is already effectively total access, because it holds write on `module` and modules are
served as executable JavaScript through `/esm`. There is nothing functional left to grant above it.
`super` and `owner` add **authority over the rules**, not power over the site.

| role | capability | authority over the rules |
|---|---|---|
| `developer` | total (module write ⇒ arbitrary JS) | none |
| `super` | same as `developer` | may write `role` and `config` |
| `owner` | same as `developer` | everything `super` has, **plus** exclusively adding/removing `super` and transferring `owner` |

Neither `super` nor `owner` may assign or remove `owner`/`super` — that is `owner`-only. A `super`
grants `admin`/`editor`/`author` freely and cannot mint a peer.

**The change that actually closes the hole: `admin` loses `role` write.** Today `role.ts` grants
`ROLES.admin` `write: ALL`, and that single line is the whole escalation chain — admin writes
`role`, grants itself `developer`, and developer is arbitrary JS on loewald.com. Moving `role` write
to `super`/`owner` severs it at the first step, and the monotonicity invariant then prevents
`super` from re-opening it at the second.

The property that breaks the circularity is **monotonicity: no write may increase the writer's own
authority.** The data stays inside the system; the *transitions* are constrained.

**Why this needs `isWriteAllowed` (§4.2), and is its first load-bearing requirement.** The current
model is *collection × method × fields*. This rule is about **values** and needs **before-and-after**
state — "did this write add or remove `owner`/`super` anywhere?" — which is exactly what §4.2
receives and nothing else does. It must also cover the **indirect** grant: appending your uid to an
existing owner role's `userIds` confers owner just as surely as editing a `roles` array, so the
invariant is over the effective principal→role mapping, not over one field.

**Open, now downgraded by Layer 0:**

- **Last-owner / orphaning.** "Only owner can remove owner" allows the last owner to remove
  themselves. This is *recoverable* (Layer 0), so it is a documented recovery procedure rather than a
  design blocker — but transfer should still be atomic (add-then-drop in one transaction) so the
  common case never depends on the escape hatch.
- **IAM hygiene is now part of the security posture.** Since Layer 0 is the real root, "who holds
  Firestore write on this GCP project" is a security question that lives *outside* this repo and
  should be reviewed deliberately.

**`config` stays inside the system** — today it is site settings, so ordinary `super`/`owner` RBAC
is right. **Revisit at Phase 1:** the roadmap makes collection configs *data*, and config carrying
rules would make it meta, at which point it joins `role` under the invariant above.

### Third-party APIs as capabilities — what 0.13.11 already gives us

*"Add a third-party API via ajs rules and glue → new capability, no deployment."* Checked against
0.13.11's actual runtime (`vm/runtime.d.ts`), and most of the substrate is already there:

- **Our bespoke endpoints map almost 1:1 onto existing core ops.** `EFFECTFUL_CORE_OPS` ships
  `httpFetch`, `storeGet`/`storeSet`/`storeQuery`/`storeQueryWhere`/`storeVectorSearch`,
  `llmPredict`, `cache`, `memoize`, `storeProcedure`/`releaseProcedure`. That is `/stored`, `/doc`,
  `/docs`, `/gen`, and `/cachedQuery` respectively — **strong evidence for collapsing them into
  capabilities rather than porting them as endpoints**.
- **`defineAtom(op, inputSchema, outputSchema, fn)`** is the "installed beside it" seam, described
  in-tree as existing "to bring HOST data *in*". Since 0.13.6 it defaults to `effects: 'io'` so the
  membrane is on by default — it previously defaulted `'pure'` and *silently* disabled sanitisation
  for exactly the third-party-shaped atoms that needed it (tjs-lang#38). Another entry for the
  fail-loudly ledger, and a caution: our capability wrappers must be audited for effect tagging.
- **Per-atom call quotas are the cost control, not fuel.** Fuel meters work *inside* the VM and is
  "blind to what an atom summons outside it: an `llmPredict` costing 50 fuel might cost real money,
  and a `httpFetch` costing 10 might hammer someone else's service." So a third-party capability
  needs a **quota**, not just a gas price. **Caveat to carry:** a quota counts calls within one
  `vm.run`; a capability that re-enters the VM gets a fresh counter, so re-entrancy multiplies the
  allowance. Any capability we expose must not offer a re-entry path, or the quota is decorative.

**The credential is the part that isn't free.** An ajs proc is *stored data* — anyone who can read
the proc can read a key pasted into it, so "glue" cannot hold credentials. Two shapes, and the
difference decides whether "no deployment" actually holds:

1. **Bound atom** — `defineAtom('weatherGet', …)` closes over the credential host-side; the proc
   calls `weatherGet(city)` and never sees the key. Clean ocap, but installing it is *host code*, so
   it costs one deploy per integration. "No deployment" does **not** hold.
2. **Secret handle resolved host-side** — the proc references a credential by name
   (`httpFetch({ url, auth: secretRef('weather') })`) and the host substitutes the real value at
   call time, refusing to return it into VM scope. Genuinely no-deploy, and the credential still
   never enters ajs. **This is the shape worth designing**, and it is where RBAC-over-functions does
   real work: the grant says *which roles may spend which secret against which hosts*.

**Security consequence, and it is the whole design:** raw `httpFetch` must almost certainly **not**
be grantable to a stored proc. Unrestricted egress in a procedure that also holds a privileged read
is an exfiltration channel (and an SSRF one), which is precisely the amplification §2.2 exists to
prevent. The grantable unit should be a **narrowed** capability — allowlisted host(s), bound or
referenced credential, quota — with raw `httpFetch` reserved for the TCB. That narrowing *is* the
"permitted arguments" half of the capability map above, which makes it the concrete first thing to
design rather than a later refinement.

## Open questions worth pinning

- **What exactly is the universal (stored-ajs) endpoint** — its call shape, how a stored proc is
  named/versioned/authorized, its gas price — and which current endpoints (`/gen`, `/stored`,
  `/cachedQuery`, `/state`, `/sitemap`) collapse into it vs. stay bespoke. *(Partly answered by
  "RBAC over functions" above: `/stored` and `/gen` look like **capabilities**, not endpoints.)*
- **How tjs-lang 0.13.1's** capability/typing model shapes the backend internals — now *checkable*;
  re-run the VM spike.
- **The tjs-lang backend-move seam** — absorb its reference `functions/` wholesale, or re-derive
  from loewald's stronger RBAC?
- **Which client bits go standalone (`tosijs-blog`/`tosijs-assets`) vs. upstream into tosijs-ui.**
- **Unified versioning** across modules / procs / schemas / docs-as-source — still one mechanism.
