# Adversarial design review: computed collections + render on store (2026-10-03)

Scope: `docs/design/computed-collections.md` (#2810) and the engine/use in
`functions/src/render/{computed,store,hooks,site}.ts` at `2c49fe0`. Three independent
reviewers (security/RBAC, correctness/consistency, cost/abuse/ops), each told to break it.
Exposure at review time: **sandbox only**. Verified: loewald.com's prefetchData ignores
`engine=store` (old code) and its `system:render` is empty.

**Verdict: BLOCK for switching loewald.com to render on store.** Converging findings, ranked:

## Blockers (current code)
1. **Inputs outside the key → cache poisoning** (security B1, correctness M1). `route(key, url)`
   stores `head.url` from the request URL (attacker-controlled via `x-forwarded-url` or
   `prefetchData?engine=store&url=`); key `page:home` can be stored with og:url
   `https://evil.example/…`, refilled by the attacker right after any write. Same class:
   `/about/junk` shares key `page:about`; the sitemap host is read outside its compute.
   **Invariant: a compute may depend only on its key and its recorded deps.**
2. **Every route depends on the blog index → any post write invalidates the whole site**
   (cost B1, security M1, correctness M3). `route()` reads `blogIndex` unconditionally, so
   `list:post` cascades to every route, every negative and every 404, inside the save request.
3. **Unbounded keys from caller input** (cost B2, security M1, correctness B3). Each unknown URL
   stores a value forever (a null, or a full copy of the 404 page served as 200); `|` in a
   segment injects hydrated paths; feeds blocker 2; the per-IP limit is per instance and keys
   on the leftmost X-Forwarded-For (board #1622).
4. **First-fill / changed-deps race** (correctness B1, security M2). A key that does not exist
   yet (or whose deps changed) is invisible to `dependents()`; a reader that read pre-write
   sources `create()`s it after the write's invalidation ran, and it is never invalidated.
   Normal after every version bump. The unit test invalidates by key, so it never modelled this.
5. **Cached source reads** (correctness B2, cost M1). `getDoc`'s per-instance `docCache`
   (config: 300s) feeds recomputes pre-write data, stored as fresh with no expiry.

## Major
6. **Privileged reads in "always public" renders** (security B2): route table and sitemap use
   the Admin SDK.
7. **Changes that are not invalidating writes** (correctness M2, security M3): console/seed/
   restore writes, collections other than post/page/config named by page patterns, registry
   (access-rule) changes, lookup fields frozen at import, swallowed failures. Needs a backstop
   max age on every value and a manual invalidate path.
8. **Silent failures, no operator view** (cost M3): every write error is treated as a lost race;
   BulkWriter results unawaited; no list/inspect/purge tool.
9. **Namespaces** (cost M2, correctness M4): old versions never deleted and still scanned;
   `computed:` deps carry no namespace.

## General rule (design)
- **Whose rights:** only values computed AS THE PUBLIC may be stored; any other principal's
  compute runs per read, unstored, with the collection's read filters applied to the OUTPUT
  (filters cannot run "before" a miss — there is no document yet).
- **override:** an ordinary source document with ordinary write access, checked first on read;
  writing it invalidates `computed:` dependents; an owner purge exists.
- **through:** every mapped source write authorized AS THE CALLER, in one transaction; else refuse.
- **store:** a stored fallback records `doc:<coll>/<self>` so a real write supersedes it.
- **list:** cache only public lists; normalize and bound queries (no per-cursor keys); unique
  sort-key cursors; test list⊆get under the race.
- **Stored ajs:** a per-request fuel/IO budget across nested computes; dependency caps; no
  network capability for stored values without max age; output schema checked before storing.
- Author-controlled page `regexp` runs per request (ReDoS) and feeds key construction: validate.

---

**STATUS: CLEARED** (recorded 2026-10-07; the switch itself was 2026-10-03, `751c3a4`). Blockers 1–5 were fixed in `2737244` and re-reviewed; the re-review's majors were fixed in `18e021c` (store-enforced keep rule, non-fatal log, prefix at serve, 24h backstop). `scripts/compare-render.js` showed 796/796 URLs identical before the switch. The closure was not written here at the time, which the 0.4.0 pre-tag review flagged. Majors 6 and 9 remain open, and 7 and 8 are partly answered; they are on the board under #2698 (comment of 2026-10-06), with the 0.4.0 review's follow-ups in #3108.
