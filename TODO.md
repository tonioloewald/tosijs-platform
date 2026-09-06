# tosijs-platform TODO

## Strategic direction

See **[ROADMAP.md](ROADMAP.md)** (rewritten 2026-08-24) — the platform **consolidates into the pure
backend** (`/doc` + `/docs` + a universal stored-ajs endpoint); client code moves out to tosijs-ui /
`tosijs-blog` / `tosijs-assets`, and this hosting becomes a tosijs-ui build deployed to Firestore.
The bespoke blog/page/prefetch system is slated for *removal/extraction*, not extension — don't
invest in it. The ajs/security design is grounded on **tjs-lang 0.13.1** and is *provisional*
(re-run the VM spike before building internals).

> The phase numbering in the subsections below **predates the roadmap rewrite** — trust
> [ROADMAP.md](ROADMAP.md)'s phases for ordering; the task detail here is still useful.

### Near-term (Phase 1 — port rules to tjs-lang)

- [x] **Backfill characterization tests for the `validate` / write path** *(done)* —
  emulator-free legs covered in `functions/src/collections/validate.test.ts` + additions to
  `access.test.ts` (`module.validate` `existing`/revision provenance, the tosijs-schema
  validation leg for every content schema, multi-role precedence, sub-collection access,
  write-side field maps). The formerly-deferred legs (`unique`, provenance stamping, schema/
  validate rejection) are now covered end-to-end against emulators in
  `write-path.integration.test.ts`, which also verifies both bug fixes below E2E.
  - **Tooling note:** the global `firebase-tools` is **10.1.0**, which is incompatible with
    firebase-functions v7 (the functions emulator runtime calls the removed `functions.config()`
    and crashes on startup — this breaks `bun start-emulated`). Workaround used:
    `npx -y firebase-tools@latest emulators:start --only auth,functions,firestore`. **Upgrade the
    global `firebase-tools`** (also used by `bun deploy*`).
- [ ] **Engine-vs-data split of `functions/src/collections/access.ts`** — decide which lines stay
  compiled TCB (role-precedence walk, field-filter mechanic) vs. become ajs procs. This defines
  the frozen atom ABI.
  - **DECIDED (2026-09-05): option (a).** The 0.13.11 re-run settles the fork in finding 4 below —
    transform / field-strain / provenance / unique stay **compiled TCB**; ajs rules stay **pure
    predicates**. Option (b) (rules return transformed `newData`) is the exact shape
    [tjs-lang#52](https://github.com/tonioloewald/tjs-lang/issues/52) corrupts *silently*, so it is
    gated on that fix plus a reason better than convenience. See ROADMAP Phase 0.
  - **VM spike re-run** (2026-09-05, tjs-lang **0.13.11**) — now a test, not a scratchpad script:
    `functions/src/collections/tjs-lang.baseline.test.ts` (12 pass). It asserts both the properties
    the port *relies on* and **tripwires that fail when tjs-lang#52 is fixed** (at which point the
    workarounds below can be deleted). Deltas from the 0.12 spike:
    - **Still true:** fuel halts a runaway rule; zero-capability rules can't reach I/O; member
      assignment still forbidden; pure boolean predicates correct. Finding 5's context-binding
      wrinkle is **gone** — `Eval` binds `context` fine on the node/dist path, and `SafeFunction`
      works with the documented `{ params, body }` signature.
    - **New:** `maxSourceBytes` refuses oversized source *before* transpilation (transpiling isn't
      fuel-metered) — a denial-of-wallet guard we should adopt for any hosted stored-proc endpoint.
    - **New, and it invalidates finding 2's remedy:** finding 2 said "rewrite validators
      functionally with spread". **Spread is silently a no-op on 0.13.11** — `{...d, c:3}` → `{c:3}`,
      `[...a]` → `[null]` — and returning a context dot-path yields the path *string*
      (`return doc.owner` → `"doc.owner"`). No error in either case. Use `Object.assign({}, data,
      {…})` + bracket access instead; both are asserted in the baseline test.
  - **VM spike, original run** (2026-08, `scratchpad/spike.mjs` — lost with the scratchpad, which is
    why the re-run is a committed test). Findings that constrain the split:
    1. **The VM runs our logic correctly** — `module.validate`'s revision provenance ported to AJS
       matches all 5 oracle cases; fuel metering halts a runaway rule ("Out of Fuel").
    2. **AJS forbids member assignment** (`data.revisions = 0` → TranspileError "Only simple
       variable assignment is supported"). Every validator that mutates `data` in place must be
       rewritten **functionally**: compute into a local, `return { ...data, revisions }`. Spread,
       `??`, `?.`, ternary, `Object.keys`, `.map`, template literals, `let` reassignment all work.
    3. **The reference rule model (`tjs-lang/functions/src/{rbac,store}.tjs`) is a pure,
       ZERO-capability predicate.** Rules run `Eval({ code, context, capabilities: {} })` and return
       `boolean | { allow, reason }`. The trusted **host** (`store.tjs`, a full `.tjs` module that
       *may* import firebase-admin) does ALL I/O — loads the doc + roles, preloads them into
       `context`, performs the write, updates indexes. A rule reaching for I/O fails closed (unknown
       atom). Relational checks = host preloads into context, **not** the rule calling out.
    4. **Biggest gap — the reference has no transform/provenance step and no field-level access.**
       `store.tjs` writes `data` as-is with `{ merge: true }`; there is no `_created`/`_modified`
       stamp, no revision increment, no `unique`; rbac shortcuts are doc-level + `owner:field`;
       `query` returns full docs (no field-strain); roles are a flat `includes()`, not our 6-role
       precedence walk. So our **`validate`-as-transformer**, **`FieldAccessMap`**, **list
       field-strain**, and **role hierarchy** have NO equivalent — they ARE the porting work, and
       they don't fit the pure-predicate rule slot. Options to resolve: (a) keep transform +
       field-strain + provenance + unique in the compiled host/TCB and let ajs rules stay pure
       predicates (closest to the reference; smallest ajs surface), or (b) extend the rule contract
       so a rule may return transformed `newData` + a field mask (richer ajs, bigger blast radius).
       **This is the fork the split decision turns on.**
    5. **Tooling wrinkle:** the standalone browser dist (`dist/tjs-eval.js`) `Eval` context-binding
       rejects `context` vars ("args do not match expected schema") and leaks a timer that hangs the
       process without an explicit `process.exit`. `SafeFunction` with explicit params works cleanly.
       A real port depends on the **functions-runtime** path (how `rbac.tjs` calls `Eval`), not the
       browser dist — confirm that path binds `context` before building on it.
- [x] **Fix `doc` endpoint access-denial opacity** *(found when emulators finally ran the
  skip-guarded integration tests)* — the HTTP `doc` handler sent a raw `403 'forbidden'` on
  authorization failure, leaking that a protected collection exists, while the internal `getDoc`
  helper already returns an opaque 404 to non-privileged callers. Aligned the handler with the
  `opaqueError`/PRIVILEGED_ROLES design (non-privileged → 404; admin/dev/owner still see 403).
  Client is unaffected (it only checks `status/100 !== 2`). **Resolved 2026-09-06:** list denials
  are opaque too. `/docs` returned 403 for the same collection `/doc` hid behind a 404, so listing
  disclosed the existence reading was careful to conceal — and the repo's own integration tests
  asserted both, adjacent in one file. `PRIVILEGED_ROLES`/`hasPrivilegedRole`/`opaqueStatus` now
  live in `collections/access.ts` and are shared, with `opacity.test.ts` pinning the *pair* rather
  than either endpoint (the defect was them diverging, which per-endpoint tests can't catch).
- [x] **Fix the broken `filterFields` branch in `getMethodAccess`** — was `delete access.key`
  (deletes a literal `.key`) inside `for (const key in Object.keys(...))` (iterates indices), so a
  role's `FieldAccessMap` was never intersected with the client's requested fields (`docs.ts`
  passes `?f=` here for LIST). Fixed to build a fresh intersected map (no mutation of the shared
  `COLLECTIONS` config); covered in `access.test.ts`. Not a privilege escalation — the role map
  still bounded results — but a real over-fetch/correctness bug.
- [x] **Fix `module.validate` revisions-on-create bug** *(found during backfill)* — the `doc`
  handler passes `existing = {}` (never `undefined`) on create, so `module.validate`'s old
  `!existing → revisions = 0` branch was dead and a newly created module computed
  `existing.revisions (undefined) + 1` → `revisions = NaN`. Fixed in `collections/module.ts`
  (detect create by emptiness; guard the increment with `?? 0`); regression tests in
  `validate.test.ts`. Our bug (doc.ts ↔ module.ts interaction), not upstream.
- [ ] **Port `/doc`, `/docs`, and rules to tjs-lang**, verified in shadow mode against the current
  TS implementation.

### Phase 2 prerequisites

- [ ] **SEO surrender loose ends** — confirm tosijs-ui doc system emits per-URL `<meta>`/OG tags,
  and a freshness/invalidation-on-publish hook, before deleting `prefetch.ts`.
- [ ] **Enumerate-then-map the blog** — inventory `blog.ts` + editors, map each feature to
  {web component | rules+proc | missing tosijs-ui primitive}. No silent third bucket.

## Pre-release review follow-ups (2026-09-06)

From [`reviews/2026-09-06-backend-consolidation.md`](reviews/2026-09-06-backend-consolidation.md)
(verdict BLOCK; all 3 blockers fixed in `5583196` and deployed). 25 follow-ups + 5 completeness
gaps, ordered by *danger*, not by lens. Upstream items are in [UPSTREAM.md](UPSTREAM.md); process
items were written back to `tosijs-coding-practices`.

**P0 — dangerous, in code we were about to schedule or already ship** — ✅ ALL DONE
(`0e3213e` retention safety + permissions, `f987527` restore path, and the LaunchAgent generator)

- [x] **F15 — backup prune deletes by filename pattern with no ownership check.**
  `scripts/backup-firestore.js`. `readdirSync` → filter `/^\d{4}-\d{2}-\d{2}T/` →
  `rmSync(recursive, force)` with no `isDirectory()`, no manifest check, no project match; the
  default root is a constant, so two projects sharing it prune each other. Reproduced in the review
  deleting a foreign directory *and* a foreign PDF. Namespace the root by project id; require a
  readable `manifest.json` whose `project` matches before deleting.
- [x] **F17 — backups write the admin-only `role` collection world-readable.** Verified on disk:
  `role/*.json` is `-rw-r--r--` with populated `contacts` (email/phone/address). Server-side
  encrypted-at-rest becomes laptop-local plaintext, 30 snapshots deep, Time-Machined. Use
  `{mode: 0o700}` / `{mode: 0o600}`; make `role` opt-in.
- [x] **F16 — `--quiet` silences the only record of deletions, in the one config that deletes.**
  The plist runs `--quiet --keep 30`; `log()` is a no-op under `--quiet` and prune lines are the
  sole trace anywhere. Route prune output through `console.error` unconditionally; record `keep`
  and pruned names in the manifest.
- [x] **F19 — there is no restore path.** The backup tags Firestore natives
  (`timestamp`/`bytes`/`reference`/`geopoint`) and nothing decodes them. A backup never
  demonstrated to restore is not a backup. Write `scripts/restore-firestore.js` (through `/doc`,
  so validation/provenance/RBAC still apply) and a round-trip test.
- [x] **F18 — don't ship a personal LaunchAgent in a clone template.**
  `scripts/com.loewald.tosijs-backup.plist` hardcodes one developer's paths and claims the global
  label `com.loewald.tosijs-backup`; `create-tosijs-platform-app` clones the repo verbatim. Generate
  it (`bun run backup:install`) from `cwd`/`homedir`/`which bun`, label from the `.firebaserc`
  project id; add `backup:uninstall`.

**P1 — a shipped claim is false, and it fails open**

- [ ] **F3 / U2 — "pure predicates are unaffected by tjs-lang#52" is WRONG.** Reproduced on 0.13.11:
  `Eval({code:'return doc.published', context:{doc:{published:false}}})` returns the *string*
  `'doc.published'` (truthy) with no error; same for `const p = doc.published; return p`. Upstream
  `rules.tjs` ends `allowed: !!result`, so a corrupted rule **grants access**. This claim is cited
  as the basis of a shipped decision in `ROADMAP.md`, `TODO.md` and `write-pipeline.ts`. Correct all
  three, add a RELIED-ON case asserting a bare dot-path predicate is not silently truthy, and
  promote the `isWriteAllowed` non-boolean→false invariant out of `test.todo`. Upstream half is U2.

**P2 — tests that cannot see the thing they claim to cover**

- [ ] **F2 — add tests that fail if the shipped backend changes are deleted.** Mutation testing
  showed deleting the whole `afterWrite` block and reverting the opaque LIST status left the suite
  byte-identically green. *(Partly done: `blockers.test.ts` now covers `afterWrite`-on-DELETE and
  is mutation-verified. Still missing: the opaque-LIST wiring, and a real endpoint harness — no
  test imports `./doc` or `./docs`.)*
- [ ] **F11 — cover `src/blog.ts`'s pure logic.** `inferResolutions`, `computeProofNotes` are pure
  and untested; `inferResolutions` silently picks a side when both fit, which mis-attributes the
  author's prose. There is no `src/*.test.ts` at all — and B1 (data loss) shipped from this file.
- [ ] **F1 — enforce or fail-closed the write-side access config.** `AccessConfig.write` is typed
  and documented as `ALL | FieldAccessMap | AccessFilterFunc`, but the write branch only tests it
  for truthiness — a field map or ownership predicate grants unrestricted write to every field.
  Latent only because all five shipped configs use `write: ALL`. Either apply the strainer, or
  reject non-`ALL` write configs at registration.
- [ ] **F5 — three raw 403s remain in `doc.ts`** (`:333`, `:398`, `:400`) leaking existence via
  "document X already exists" / "cannot update non-existent document X". *(1 of 5 done — the DELETE
  branch.)* Add a table-driven test over the endpoint's denial branches, since `opacity.test.ts`
  imports only `./access` and structurally cannot notice.

**P3 — shadow mode / pipeline hygiene (nothing ships on it yet)**

- [ ] **F7 — `SHADOW_WRITE_PIPELINE` has no operational half**: no `.env`, no `firebase.json` env,
  no deploy flag, no docs. Meanwhile the *tested* copy is the one that doesn't ship. Document how to
  enable it on deployed v2 functions, or record the twin as carried-unverified.
- [ ] **F8 — the shadow pass is `await`ed after `res.send()`**, so on Cloud Run gen2 it holds a
  billed concurrency slot; the comment claims it "can neither slow nor alter the request". Either
  `void` it or correct the comment.
- [ ] **F9 — shadow shares nested references with the live write** (`{...req.body.data}` twice), so
  a transform mutating a nested value makes the shadow re-derive from mutated input and report a
  false match. `structuredClone` both captures. Also: it runs `validate` twice per write.
- [ ] **F10 — `COLLECTIONS.test.validate` sets `Math.random()`**, guaranteeing a permanent shadow
  MISMATCH. Moot now that B3 gates the collection to emulators, but re-check if it returns.
- [ ] **F12 — document `isUnique` as partial application** at the cutover site; a reviewer read the
  2-arg form as dropping self-exclusion and predicted every re-save would fail.
- [ ] **F4 — soften or close the blog-cache repopulate race.** `onPrefetch` unconditionally
  `setRecord`s after a rebuild, so a rebuild straddling the commit still replaces the `cleared`
  marker with pre-write posts stamped fresh. The `cleared` field is written but **never read**.
  Make it a CAS inside a transaction, or downgrade the "closes the window" comment to "narrows".

**P4 — packaging, drift, hygiene**

- [ ] **F13 — declare `tjs-lang` in `functions/package.json`** and pin it EXACTLY: the baseline test
  holds deliberate tripwires asserting tjs-lang#52 is still broken, so a caret flips the suite red
  unpredictably. It currently resolves only by walking up to the root `node_modules`; a clean
  `npm ci` in `functions/` leaves the suite unrunnable.
- [ ] **F14 — reconcile tjs-lang version drift**: code pins `^0.13.11`, `ROADMAP.md`/`CLAUDE.md`
  still say 0.13.1.
- [x] **F20 — two decoders, already drifted.** REST tags `geopoint`/`reference`; the admin path
  handles only `toDate()`/`Buffer` — so a `GeoPoint` or `DocumentReference` backs up differently
  depending on the operator's credentials. Converge on one shape + a fixture test per scalar type.
- [ ] **F21 — the backup's collection list is a second, silently-drifting registry.** A new content
  type drops out of backups with no signal; the empty-guard only fires at zero *total* docs.
- [x] **F22 — `--collection X` writes a normally-named partial snapshot** that occupies a retention
  slot, so debug runs can prune complete snapshots. Name partial runs distinctly.
- [x] **F23 — the LaunchAgent's log dir may not exist at first run**, discarding the very
  credential error its own Notes tell you to look for. (Subsumed by F18.)
- [ ] **F6 — coalesce proofread annotation repositioning into one rAF pass.** O(N²) forced layouts
  on Apply (~820 for 40 notes) and an unthrottled O(N) pass per keystroke thereafter. Admin-only,
  cosmetic. Add `disconnectedCallback` cleanup.
- [ ] **F24 — print a bundle-size delta** against a committed baseline (measured +1,150 B this
  diff; the gap is the missing measurement).
- [ ] **F25 — drop the unused `@codemirror/lint` dependency** — it invites the next contributor to
  import `@codemirror/*` and re-hit the duplicate-instance breakage. See U1.

**Completeness gaps (from the same review)**

- [ ] **G1 — there is no release to cut.** Zero git tags; `package.json` reads `1.0.6` at both ends
  of the reviewed range. Decide the version, bump, tag — or stop calling it a release review.
- [ ] **G2 — the integration suite has never actually run.** 12 cases print `[SKIPPED]` while the
  suite reports pass. Every write-path change this cycle went un-exercised end-to-end. Run it
  against emulators before tagging and record that it executed.
- [ ] **G3 — the `/docs` 403→404 change is an unversioned public-API contract change** with
  `docs/FIRESTORE_API.md` untouched and no external-consumer inventory.
- [ ] **G4 — three dependency bumps validated no further than "it compiles"** (`tjs-lang`
  0.12→0.13.11 carrying a known open bug, `tosijs` 1.8.2, `tosijs-ui` 1.12.8).
- [ ] **G5 — no CHANGELOG.md** (Tier 0 failure), and published `1.0.6` has no tag naming it.

## Outstanding Work

### Testing & Quality

- [ ] **Automated tests for /doc endpoint** - See [functions/src/TODO.md](functions/src/TODO.md)
  - CRUD operations
  - Validation rejection
  - Unique constraint enforcement
  - Role-based access control
  - Nested collection permissions

- [ ] **End-to-end tests**
  - Auth flow (sign in, sign out, role assignment)
  - Blog CRUD operations
  - Media upload/management

### Multi-Environment Support

- [ ] **Staging/testing backend configuration**
  - Easy switching between production, staging, and test Firebase projects
  - Environment-specific config files (e.g., `firebase-config.staging.ts`)
  - CLI flag or env var to select environment at build/dev time
  - Document recommended setup for test/staging projects

- [ ] **Seed data scripts**
  - Script to populate test/staging with sample content
  - Reset script to clear test data

### Developer Experience

- [ ] **Improve create-tosijs-platform-app**
  - Option to skip TLS cert generation (for CI/CD)
  - Validate Firebase project exists before cloning
  - Better error messages for common setup issues

- [ ] **Local development improvements**
  - Optional Firebase emulator support for offline development
  - Mock auth for testing without Google sign-in

### Documentation

- [ ] **API documentation**
  - OpenAPI/Swagger spec for /doc and /docs endpoints
  - Example curl commands for all operations

- [ ] **Deployment guides**
  - Custom domain setup walkthrough
  - CI/CD pipeline examples (GitHub Actions, etc.)
  - Cost optimization tips

### Features

- [ ] **Media management**
  - Image optimization/resizing on upload
  - Bulk upload support
  - Media library UI improvements

- [x] **Content features**
  - [x] Scheduled publishing (publish date in future)
  - [ ] Draft previews with shareable links
  - [ ] Content versioning/history

- [ ] **Search**
  - Full-text search integration (Algolia, Typesense, or built-in)
  - Search UI component
  - Vectorize messages and use vector engine + regex

- [ ] App Store (macOS) Support
- [ ] iOS Support



### Extensibility

- [ ] **Component editor**
  - Visual editor for adding components/libraries to pages
  - Direct component upload or CDN link ingestion
  - Components become available site-wide after ingestion
  - Versioned, cache-friendly endpoint for component delivery
  - Parallel self-assembly of page components
  - Learned dependency graph: system observes import() chains and caches transitive dependencies
  - Subsequent loads parallelize all dependencies (bundling benefits without bundling)
  - Each component independently cacheable and updatable

### Performance

- [ ] **Caching improvements**
  - CDN cache headers configuration
  - Stale-while-revalidate patterns
