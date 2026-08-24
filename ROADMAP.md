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

Not a frozen invariant list. The prior reasoning (amoral VM + capability boundary; gas prices I/O
not just CPU; determinism → emulator-free testability; schema = intra-document vs ajs = inter-value;
provenance fields the subject can't write; authority in the read/cache key; typed
discriminated-union write outcomes; buffered/transactional capabilities) captured real design
pressure and much will likely persist **in some form** — but 0.13.1 (released; shape settled,
patches possible) reworks the VM/capability/typing model, so treat it as **design intent to
re-validate against 0.13.1's primitives**.

**Action:** re-read 0.13.1's model, then re-run the VM spike (the `module.validate` oracle against
the characterization tests) on 0.13.1 to re-derive the backend contract before committing internals.

## Phased plan

- **Phase 0 — baseline on tjs-lang 0.13.1.** Released; shape settled. Re-run the VM spike against
  0.13.1; reconcile the carried-over security design with its model. Blocks Phase 1 internals.
- **Phase 1 — consolidate the backend.** Bring tjs-lang's reference universal-endpoint / batteries
  here (or eliminate), unify with loewald's stronger RBAC, and collapse the service surface toward
  `/doc` + `/docs` + one universal stored-ajs endpoint. Everything else re-expressed as collection
  config or stored ajs — *demonstrated*, not asserted.
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

## Open questions worth pinning

- **What exactly is the universal (stored-ajs) endpoint** — its call shape, how a stored proc is
  named/versioned/authorized, its gas price — and which current endpoints (`/gen`, `/stored`,
  `/cachedQuery`, `/state`, `/sitemap`) collapse into it vs. stay bespoke.
- **How tjs-lang 0.13.1's** capability/typing model shapes the backend internals — now *checkable*;
  re-run the VM spike.
- **The tjs-lang backend-move seam** — absorb its reference `functions/` wholesale, or re-derive
  from loewald's stronger RBAC?
- **Which client bits go standalone (`tosijs-blog`/`tosijs-assets`) vs. upstream into tosijs-ui.**
- **Unified versioning** across modules / procs / schemas / docs-as-source — still one mechanism.
