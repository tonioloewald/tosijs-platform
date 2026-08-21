# tosijs-platform Roadmap — the ajs / universal-endpoint direction

> Strategic direction distilled from design discussion (2026-06/07). This supersedes
> the SSR/prefetch-centric architecture. See [TODO.md](TODO.md) for near-term tasks.

## The thesis

Today the platform has a split personality:

- **Client behavior is data** — modules live in Firestore, served via `/esm`, hot-swappable, no deploy.
- **Server security/validation is code** — every collection's `validate`/access logic is
  trusted TypeScript that must be `deploy`-ed.

**tjs-lang / ajs** closes that gap. ajs is a Turing-complete, deeply-async, type-safe,
sandboxed, **gas-limited and time-boxed** language with **no ambient authority** — it can
only call capabilities you explicitly hand it. That makes validation and access logic into
**safe stored procedures**: data in Firestore, versioned, evaluated server-side without the
arbitrary-code-execution catastrophe that a naive `eval` would be.

The prize is bigger than "store rules as data." Because the `/doc` and `/docs` endpoints
already solve fine-grained security, ajs just *calls that solved problem*. The Cloud
Functions layer becomes a **universal endpoint** — a generic interpreter — and every site
becomes pure data: schemas + access rules + validators + modules. **Deploy the platform
once; everything else is content.** That's the README's "PHP/LAMP simplicity" thesis finally
reaching the server tier.

End state: **one substrate — versioned documents, some of which are executable, behind a
secured universal endpoint.** "Blog / IDE / word-processor / literate-programming platform"
are four views of that one substrate, not four products.

## Design invariants (decisions already settled — do not relitigate)

These were reasoned through and are the load-bearing constraints. Violating one reintroduces
a class of bug we already designed out.

1. **The VM is amoral.** ajs knows nothing of roles/fields/tokens. Security lives entirely at
   the capability (atom) boundary. A proc runs *as the caller* (`SECURITY INVOKER` by default) —
   it can only do what the caller could already do by hand. Least privilege is the default.

2. **Guarantees are confinement, termination, type-soundness — NOT correctness.** Correctness
   is undecidable (Rice) and we don't claim it. "Provable security" = provable *confinement*
   (can't escape the atoms) + *termination* (gas/time enforce halting by construction) +
   *type-soundness* (ask for a `T`, get a `T` or a clean error). It bounds the blast radius; it
   does not verify intent. Keep the marketing honest about this.

3. **TCB = the atom set + the VM + the auth atom.** Procs are *untrusted-but-safe*, so you
   never audit a proc. You audit the finite menu of atoms (trusted code) and the VM. This is the
   whole security payoff: audit surface collapses from "all the logic" to "the doors the logic
   may open."

4. **Gas prices I/O, not just CPU.** Every capability invocation draws gas at a host-set
   per-atom price. Metering only interpreter steps is theater — a proc doing 10k cheap-looking
   `getDoc`s is a DoS. Gas is *local*; **amplification is global**.

5. **Outside-world atoms do NOT dissolve like doc atoms do.** `gen` (LLM) and `stored`
   (storage) reach external, token-bearing endpoints — the reflection/DoS surface. They stay
   bespoke, narrowly typed, and rate-limited; procs reach them through a deliberately stingy
   interface, or not at all. The blog reduction is clean *only because* its atoms are confined
   doc ops. Do not wave the same wand at `gen`.

6. **One write callback → a typed discriminated-union outcome.** Not staged
   guard/shape/post callbacks. The callback returns `Allowed{data} | Denied{reason} |
   Invalid{path,msg} | Conflict{…} | Failed{cause}`; the VM maps tags to HTTP semantics
   (403/422/409/500/200). Type-soundness forces the proc to say *which* kind of outcome it is,
   giving staging's clarity from the *protocol* instead of the *call structure*.
   **Keep `Invalid` (fix your payload) and `Denied` (you can't, don't retry) distinct forever** —
   collapsing them costs a debugging afternoon.

7. **Capabilities are buffered / transactional.** The write cap stages mutations into a buffer;
   the host commits only on `Allowed`. This makes the callback **pure-until-commit**: free-form
   execution order, no partial effects, and "a denied write has no effect" is recovered at
   *commit time* rather than by structural staging. It's what makes "guard by trying" cheaper
   than "guard by simulating" — attempting a transformation and discovering a missing transitive
   privilege costs nothing because nothing committed.

8. **Provenance stamps are system-owned.** Fields a policy reads to decide (`_lastWriteRole`,
   `_modifiedBy`, revision trails) are maintained by the write atom and **never** appear in any
   role's writable field set. Rule: *never let the subject write the fields your policy reads*,
   or the lock is forgeable. (This is what makes "author can't edit after an editor touched it"
   safe.)

9. **The render/read cache key must include authority.** Key = `(proc-version, doc-version,
   effective-access)`. Caching a read/HTML result without the authority dimension is a
   field-level access bypass through the cache (serve the editor's view to the public).

10. **Determinism from capabilities.** No `Date.now`, no `Math.random`, no I/O except through
    atoms. A proc is a pure function of `(inputs, capability-responses)` → replayable,
    cacheable, and **unit-testable without emulators** (mock the cap responses). This dissolves
    the current skip-guarded integration-test problem.

11. **Schema = intra-document; ajs = inter-value.** A sub-schema can only see the one value it
    strains, so it covers shape + field whitelist completely. The moment a rule depends on
    *another value* (existing state, another doc, transitive privileges) it's relational → ajs.
    Clean, predictable dividing line for "which tool does this rule need."

12. **Schema is both guard and strainer** (same engine). `read?: Schema | AjsProc`. Straining
    is type-sound: output type = the projection schema, so the read side gets typed output for
    free (nice for the renderer/cache downstream).

13. **Schema-first matters (vs zod's types-first).** tosijs-schema's schema is a serializable
    *source* artifact, so the schema itself can be **stored data** (change shape without
    redeploy) and can drive server + client + ajs strainer + the atom ABI from one source.
    Crucially, **both halves of validation/access stay serializable** — shape is a schema,
    condition is ajs — so there is no un-serializable escape hatch (zod's `.refine(closure)` is
    exactly such a hatch). The entire guard-and-shape surface is data, end to end.

14. **Unify versioning.** Modules, procs, and schemas *all* need version semantics. Don't solve
    it three times — one mechanism (the `name@version` subcollection pattern already sketched in
    `functions/src/esm.ts`'s TODO) covers code-as-data, logic-as-data, and shape-as-data.

## SEO surrender (housekeeping, but do it deliberately)

AI agents curling pages collapsed SEO back to "just serve the bytes," so SSR-on-demand
(prefetch) is no longer earning its complexity. tosijs-ui's doc system + aggressive-cache
rendering replaces it. Before deleting prefetch, close two loose ends or the surrender is lossy:

- **Per-URL `<meta>` / OpenGraph tags** — many agents and all social cards read head tags, not
  body. Confirm the doc system emits correct per-page head tags.
- **Freshness / invalidation-on-publish** — prefetch was live; static/cached rendering trades
  freshness for simplicity and needs a rebuild-or-invalidate hook on write. The instinct already
  exists (`clearBlogCache()` on save).

## Phased plan

### Phase 1 — port `/doc`, `/docs`, and rules to tjs-lang (behavior-preserving)

The good kind of scary: the current TypeScript **is the spec**, so correctness is checkable.

- **First, backfill the oracle.** The existing tests cover *dispatch* (`getMethodAccess`,
  role-walk, read/list field-strain) well — but the **`validate` / write / `unique` / provenance
  path has essentially no coverage**, and that's exactly the part being ported. Write
  characterization tests against the current TS `validate` path *before* porting, or you're
  porting the high-risk slice blind. (See [Test coverage reality](#test-coverage-reality).)
- **The real deliverable is the engine-vs-data split.** Decide which lines of
  `functions/src/collections/access.ts` stay compiled TCB (the role-precedence walk, the
  field-filter mechanic) vs. which become ajs procs (the per-collection predicates). That line
  *is* the frozen **atom ABI** everything downstream inherits — describe it as schema artifacts.
- **Run in shadow mode.** tjs-lang `/doc` computes answers alongside the TS one on real traffic,
  commits nothing, until the diff is clean. Then cut over.
- **Fix while you're in there:** the `filterFields` branch in `getMethodAccess` is untested and
  looks broken (`delete access.key` deletes a literal `.key`; `for (const key in Object.keys(...))`
  iterates indices). Dead/wrong code in the exact slice being ported.

### Phase 1.5 — authoring & bootstrap (dependency of Phase 2, easy to forget)

- **Proc/schema authoring + test loop.** Phase 1's engine *consumes* procs (Phase 1 can run on
  hand-seeded ones), but Phase 2 needs an ergonomic way to write, version, and test procs/schemas
  as data. That loop is, recursively, the IDE end-state.
- **Bootstrap seed (irreducible, stays hand-written).** Something defines the first owner, the
  atom registry, and *which* procs are allowed to be access-rules (privileged authoring tier).
  Order: hand-author the seed → build enough authoring UI → author the rest in-platform.

### Phase 2 — eliminate the bespoke content system

No behavioral oracle here — this is a *product* judgment, so the method differs.

- **Delete candidates:** `blog.ts`, `page.ts`, `sitemap.ts`, `prefetch.ts`, and the bespoke
  blog/page/schema editors. Blog becomes: records + a schema + an ajs validator + an ajs→html
  renderer that caches aggressively. Sitemap becomes an ajs renderer over a query. `esm.ts` mostly
  dissolves into "a doc rendered with `content-type: text/javascript`."
- **Method: enumerate-then-map.** The current blog *is* the spec — `blog.ts` + the editors
  enumerate exactly what must be replaced. Map every feature to one of: **web component**, or
  **rules + stored procedure**. The two-category constraint is a **tripwire**: anything that fits
  neither is either a genuine missing tosijs-ui primitive (build it) or the reduction leaking
  (a real finding). **No silent third bucket** ("…and this one special server thing").
- **Likely first gaps** (build into tosijs-ui): the **blog index as a query-shaped view**
  (renderer-over-query, like sitemap, not single-doc render); an **authoring surface** (does the
  doc system *edit*, or only render?); **per-post OG/meta** (the SEO loose end above).

### Survives as trusted code (the whole TCB, roughly)

`doc.ts` / `docs.ts` (the universal document atom — the substrate), the ajs VM + host (gas,
time, cache store), the auth atom (`user.ts`, request-credential → `userRoles`), and a hardened
`gen` / `stored`. Everything else moves into Firestore as schemas + ajs + cache policy.

## Test coverage reality

- **Well covered:** `getMethodAccess` dispatch — role-walk, inheritance, deny-by-default,
  method→access mapping, and read/list field-strain (`access.test.ts`).
- **Essentially untested:** `validate(data, userRoles, existing)` (zero coverage — and `existing`,
  the provenance input, isn't exercised anywhere), `unique`, `schema` validation, write-side field
  maps, sub-collection (`post/comment`) access, multi-role precedence (`multiRoleUser` is a
  commented-out "reserved for future tests").
- **Integration tests are skip-guarded** — they `expect(true).toBe(true)` when emulators aren't
  up (pass vacuously in CI) and assert coarse HTTP status (forced to accept `[403, 404]` because
  the opacity layer blurs what actually happened).
- **The new stuff is far easier to test** — procs are pure/deterministic/caps-only, so you feed
  `(data, existing, userRoles, cap-responses)` and assert a *tagged* outcome, no emulator needed.
  The thing that forced integration tests (live Firestore) becomes a mockable capability.

## Open questions worth pinning before/while building

- Exact capability set the VM exposes (pure over `(data, userRoles, existing)` vs. a sandboxed,
  role-checked `getDoc`/`queryDocs` handle — and the gas price of each).
- Re-entrancy story if an atom can transitively trigger another proc (this is the EVM problem
  space; async + caps + Turing-complete). Probably fine because atoms are transactional Firestore
  ops, but it's a *composition* property, not a *confinement* one — convince yourself explicitly.
- Schema evolution / migration: doc written under v1, strained by v2 — who migrates? (Folds into
  the unified versioning mechanism, invariant 14.)
