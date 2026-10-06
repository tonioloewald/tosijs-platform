# Changelog

## 0.4.0 — 2026-10-07

Setup without the cloud console, the ceremonies as pages, and pages rendered
when content is stored (D22, D23).

### Added

- **`bun run deploy`**: the whole host in order (indexes, then functions,
  rules and hosting), then checked from outside. `bun run deploy:sandbox` does
  the same for a sandbox and refuses a host that is not marked as one.
- **Every endpoint declares `invoker: 'public'` in code**
  (`functions/src/endpoint-options.ts`), so every deploy re-applies it. There is
  no IAM step to remember; a lost one is fixed by redeploying.
- **Signing set up by code**: `bun scripts/enable-signing.js --alias <host>`
  grants the functions' service account Token Creator on itself and sets the
  bucket CORS a page needs to read a signed redirect. New hosts get both from
  the provisioner.
- **One-click claim** (board #2489): `bun scripts/claim.js --alias <host>
  [--for <email>]` arms the claim for one verified email and opens
  `/claim?page`, where that person signs in and clicks Claim.
- **Install approval in the browser** (board #2490): `install-manifest.js`
  proposes a manifest with no credentials and prints a link and a confirmation
  code; a configurator opens the link, sees a dry run of what would happen, and
  approves. The host installs the manifest it stored, as that person.
  Endpoints: `POST /install?action=propose|preview|approve`,
  `GET /install?request=<id>` (the page), `GET /install?action=status`.
- **`POST /blob {op: "import"}`**: copy a file from a legacy folder (`blog/`,
  `public/`, `users/`) into a storage area on the server.
  `scripts/migrate-blog-files.js` uses it to copy a whole folder, with clean
  names; the originals stay. See BETA.md "Store files".
- **Render on store** (D23, board #2698), behind `RENDER_ON_STORE`
  (`false` | `compare` | `true`; default off). Pages, the nav, the blog index
  and the sitemap are computed on first read, stored with the documents they
  depend on, and invalidated when one of those is written. Rendering is always
  done as the public. `scripts/render-store.js` lists, shows and purges stored
  values; `scripts/compare-render.js` compares the two engines URL by URL.
  Set `SITE_HOST` when turning it on: stored pages and the sitemap name it.
- **The asset manager uses storage areas**: uploads, list, rename and delete
  go through `/blob` for a folder that is an area (`blog:public`); file names
  are cleaned on upload.
- **Kernel (npm):** `afterWrite(data, userRoles, change?)` gains a third
  argument, `WriteChange {path, before?, after?}`.

### Changed

- **`bun run deploy` now means the whole host**, and it passes `--force`:
  indexes and functions that exist on the host but not in the checkout are
  deleted without a prompt. `deploy-functions` and `deploy-hosting` remain for
  partial deploys. `enable-gen-invoker.sh` is gone (the invoker is in code).
- The backup takes **every collection the database has**, minus a short list
  of caches. It used to name five, which left out storage-area metadata,
  installed manifests, the registry and grants. The off-site archive keeps
  `token` and `system:claim` local along with `role`.
- `/stored` ignores a query string.
- An install proposal holds at most 64 KB, and at most 20 can await a decision
  at once (`429 rate-limited` past that). An authorization request's label and
  caveats together are at most 4 KB.

### Fixed

- **Google sign-in never worked on the `/authorize`, `/claim` and `/install`
  pages.** Their CSP blocked the loader popup sign-in needs
  (`auth/internal-error`), and the scripts linked to the functions' address,
  which is not an authorized sign-in domain. The pages are now served from the
  site's own domain, with a CSP that allows the loader.
- **Those pages could be framed by another site.** They grant authority on a
  click; they now send `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- **Server-rendered data could end its own `<script>`.** A post containing
  `</script>` broke out of the embedded JSON. Both render paths use one safe
  embedder.
- Anonymous authorization requests and install proposals were never deleted.
  Each new one now deletes expired ones.
- Stored-data validators no longer fail a document for the fields the endpoint
  stamps (`_by` and friends).

### Upgrading a host

Run `bun run deploy` (or deploy functions, rules **and hosting**: this release
changes all three).

- **`firebase.json`, if you maintain your own:** add rewrites for
  `/authorize`, `/claim` and `/install` to their functions, **before** any
  catch-all, and the header rule for `/@(authorize|claim|install)` from this
  repo's `firebase.json`. Without them, browser sign-in on those pages fails.
  Hosting replaces a function's headers, so the rule must carry the pages' CSP
  exactly (`functions/src/page-csp.ts`; a test compares them).
- **Signed URLs:** if you granted Token Creator by hand for 0.3.0, also run
  `bun scripts/enable-signing.js --alias <host>`. It adds the bucket CORS;
  without it a page's `fetch()` cannot read a `/blob` redirect (found by
  tosijs-virta's upgrade, board #2488). It is safe to re-run.
- **Render on store is off unless you set `RENDER_ON_STORE`.** To adopt it:
  set `compare`, run `scripts/compare-render.js`, then set `true` and
  `SITE_HOST`. After changing an access rule on a host that has it on, purge
  with `scripts/render-store.js`. The invalidation hooks run whether or not
  the flag is set (a few small writes on each post, page or config save).
- **Kernel (npm):** nothing breaks; the `afterWrite` argument is optional.

## 0.3.0 — 2026-09-30

File storage: **storage areas** and the `/blob` endpoint (board #1136).

### Added

- **Storage areas.** A manifest collection with `blob: {maxBytes, contentTypes?}`
  stores files; its access rules are the files' access rules, and public vs
  private is derived from them. `/blob/<area>/<path>`: `PUT` to upload or
  replace, `GET` to fetch, `DELETE`; `POST /blob {op: "move"}`. The server
  measures size and hash; each file has a metadata document with `_by`
  provenance, listable through `/docs`. See BETA.md "Store files".
  - **Consistency:** bytes live under a content-hash key, and metadata is
    committed before an old object is removed, so a metadata document always
    means its file exists. A crash can orphan an object, never corrupt one.
  - Delivery is a redirect to a signed URL when the host can sign (never
    cached), otherwise the bytes are streamed (public ones cache for 300s).
    A content type must be exactly one type. Streamed files are `nosniff` and
    sandboxed unless they are inert media.
  - A move needs read access to its source, and never overwrites its
    destination, even under concurrency.
  - To a caller who may write but not read, a PUT's answer never depends on
    the stored file (no `unchanged`; the same `409` in an immutable area).
  - Cost to know: a public file fetched through a redirect costs one function
    call per view (the redirect is uncached). Streamed files cache for 300s.
- **Error codes** `too-large` (413) and `unsupported-type` (415). New codes
  break exhaustive `switch`es on `error`, which is why this is a minor release.
- **Kernel (npm):** the storage-area decisions are exported: `decideRead`,
  `decidePut`, `decideDelete`, `decideMove`, `isBlobStore`, `isPublicArea`,
  `validateBlobPath`, `contentTypeAllowed`, `blobLimitsProblems`,
  `BLOB_META_SCHEMA`, and friends. Provisional through 0.3.x. **`decideRead`
  and `decideMove` are async** (they may evaluate a visibility filter);
  `await` them — `decideMove(...).status` on the bare promise is `undefined`.
- The install response lists a `blob` **capability** under `superseded`: it
  grants nothing; declare a storage area instead. It is still accepted.

### Changed

- Cloud Functions run on **Node 22** (`engines.node`). Node 20 is end of life.
- `/doc` and `/docs` refuse writes to a storage area (`403 refused`); its
  metadata is written only through `/blob`.
- A manifest upgrade cannot turn a collection into a storage area, or back.

### Fixed

- **SSR rendered posts with the site's generic title on a fresh instance.**
  The blog's prefetch handler read the resolved page from a module global that
  a concurrently running handler set; it only worked when a warm instance still
  held a previous request's page. The page is now resolved once per request.
- **`/stored` read the whole bucket with the Admin SDK** — which ignores
  `storage.rules` — so it could have served storage-area objects, private ones
  included, and answered "does this content exist?" to anyone. It now serves
  only the legacy folders.
- **Files served from the site's origin were not sandboxed in practice.**
  Hosting's site-wide CSP replaced the sandbox CSP the functions set, so an
  SVG uploaded to `blog/` (any content role can) could run script as the site
  via `/stored`. Hosting now sandboxes `/blob/**` and `/stored/**`.
- **Social previews:** `og:url` and `og:image` are absolute; a post's fallback
  image finds Markdown images, not only `<img>`; `twitter:card` is set.

### Upgrading a host

**Deploy `storage.rules` and hosting too** (`firebase deploy --only
storage,hosting`), before installing a manifest that declares an area.

- **Behaviour change — direct reads are now an ALLOWLIST.** The old default rule
  granted public read on the whole bucket, which exposed PRIVATE storage areas.
  Now only `blog/`, `public/` and `users/` are readable directly (client SDK and
  `/stored`); everything else in the bucket is served only by `/blob`. **If
  your host keeps files anywhere else, move them or add the folder** to both
  `storage.rules` and `functions/src/legacy-storage.ts` (a test checks they
  agree). The bucket root can no longer be listed.
- **`firebase.json` gains a header rule** for `/blob/**` and `/stored/**`:
  Hosting's site-wide CSP replaces a CSP set by a function, so the sandbox
  for files served from your origin has to come from Hosting.
- `/stored` now reads the project's default bucket (it hardcoded
  `<project>.appspot.com`).

Deploy the functions (the new one is `blob`), and add
`{"source": "/blob/**", "function": "blob"}` to `firebase.json`'s hosting
rewrites **before** any catch-all. A first deploy normally makes a new function
publicly invokable; check that `blob` is. Signed-URL delivery additionally needs
the functions service account to hold "Service Account Token Creator" on itself;
without it, files are streamed (correct, just proxied).

## 0.2.1 — 2026-09-26

Two fixes reported by tosijs-virta, the proving consumer.

### Fixed

- **Provenance recorded the wrong person** (#28). `_by.uid` was the first uid
  on the role document that matched, so a principal matched by contact email,
  or one sharing a role document, was recorded as whoever is listed first. On
  virta's host, every board write from a human was stamped as the host's
  service principal. `_by.uid` is now **who authenticated**. `_by.role` still
  names the document that granted the authority.
  - **Kernel (npm):** `UserRoles` gains an optional `principal: {uid, name?}`,
    which a host sets from the verified credential. `principalIdentity(userRoles)`
    is the one rule every attribution uses: provenance, a manifest's
    `derive: {op: 'principal'}` (which had the same bug), and `/token`. If you
    don't set `principal`, you get the 0.2.0 behaviour.
  - **`_by.name`, "curated when owned":**
    - The principal is the role document's sole owner: its operator-curated
      name.
    - A contact or shared match: the principal's own display name, or no name
      at all, never the document's.
    - **The rule, exactly:** a candidate name is dropped if it contains `@`
      or equals one of the principal's contact values (ignoring case). It fails
      closed, so a curated name like "Team @ Acme" is dropped too; attribution
      then falls back to the display name, or to no name. `_by.uid` is the
      identity either way.
    - Enforced where `_by` is produced, so **future** writes are covered even
      where role documents and tokens stored on live hosts carry an email.
      `/claim` used to name the first owner's role document after their email;
      it now uses their display name, or `Host owner <uid prefix>`.
    - Display names are self-asserted, so spoofing is confined to the case
      where no curated name exists.
  - **An agent's writes carry its human's name.** The minting human's display
    name is stored on the token (`principalName`, captured at `/token` mint or
    at `/authorize` approval). Tokens minted before 0.2.1 fall back.
- **An immutable or sequenced collection could be re-sequenced by concurrent
  `/doc` writes** (board #1184). `/doc` read existence outside its commit, so
  concurrent creates of one new id all saw "missing" and all committed. Those
  collections now commit through the same transaction as `/docs` batches: the
  existence check, the pipeline, uniqueness and the sequence counter all
  happen inside it.

### ⚠️ Action required on existing hosts

**Documents written before 0.2.1 may carry an email address in `_by.name`**,
and publicly readable ones (posts) are still served with it. The filter
applies to new writes only. To find what to fix:
- `scripts/audit-host.js` now lists role documents whose `name` is an email
  or one of their own contacts, and tokens whose `principalName` is.
- Rename those role documents to the name you want shown.
- Re-save, or scrub `_by.name` on, public documents written by those
  principals.

**Verified:**
- **Unit tests:** 775 passing.
- **Emulator suites:** 54 pass, including a new step: a contact-matched writer
  on a document listing someone else first is stamped as themselves.
- **Live on the sandbox:** a 5-way race on one id gives exactly one `200`,
  four `403`s, one `_seq`, and a changed rewrite gets `409`. All six ceremonies
  pass (99 checks), plus the signed-in suite (17).

## 0.2.0 — 2026-09-26

The first stable release since 0.1.0. The npm package is the decision kernel:
RBAC, the write pipeline, and role resolution. The repository is a host you can
deploy, claim, install onto and hand to agents. Two production hosts run it:
tosijs-virta's, the consumer that broke the betas and got every break fixed, and
loewald.com. The beta entries below are the detailed history. This entry is
what changed since **0.1.0**, which is what `npm install service-compris`
gave you until now.

**Verified for this release:**
- **Unit tests:** 750 functions and 799 root, all passing.
- **Emulator integration suites:** 53 pass, 0 fail, run against this code with
  the registry switch on, as production runs.
- **Live host checks** on the sandbox: the signed-in suite 17/17, and six
  ceremonies with 94 assertions.

### Upgrading the npm package from 0.1.0

- **Authorization results can change.** `getMethodAccess` now joins every
  applicable grant as a lattice. In 0.1.0 the last matching role in key order
  won, so whether a principal with two roles got more or less depended on how
  the map was written. Now holding more roles never grants less, and key order
  is irrelevant.
- **Token caveats deny.** When `userRoles.token` is present, a method or
  collection outside its caveats resolves to `undefined`, the same as no
  access. Sub-collections of an allowed collection are allowed. `LIST` is its
  own method, distinct from `GET`. (`TokenContext` is exported.)
- **`RoleName` gains `configurator`,** the role that installs libraries.
- **`WriteOutcome`'s rejection reasons gain `unattributed` and `immutable`.**
  This breaks an exhaustive `switch` over `reason`.
- **Provenance:** `data._by` is stamped from `userRoles` (uid, role document,
  name, and the token's id and label when there is one). It is never taken from
  the body. `STAMPED_FIELDS` is exported.
- **The schema validates content, not stamps.** A closed schema
  (`additionalProperties: false`) now works; in 0.1.0 it rejected every write.
  `isUnchanged` ignores `_seq` and `_by`.
- **`unique` may list several fields, each unique on its own.** A missing or
  non-scalar value in a unique field is refused as `unique`.
- **What the kernel enforces, and what only a host does.**
  - Kernel: `requireAttribution`, and `immutable` for rewrites. This needs a
    correct `exists` from the caller.
  - Host: `seq`, `afterWrite`, and refusing deletes of an immutable document.
- **0.1.0 could not be imported under Node ESM** (extensionless specifiers).
  0.2.0 can, and the publish workflow smoke-tests the packed tarball and the
  registry's copy.
- **Packaging:** the package has no runtime dependencies besides its
  `tosijs-schema` peer. It used to pull the Firebase SDK for nothing.

### Upgrading a host (from 0.1.0 or 0.2.0-beta.1/beta.2)

- **Errors have one shape**, `{error: <code>, message, details?}`, and the
  codes are a contract: see BETA.md, "Errors". New since the betas:
  - `immutable` (409);
  - `rate-limited` (429), in that shape (it used to be plain text);
  - a `/docs` batch now uses the same statuses as `/doc`, so its `validate` and
    `unique` refusals are 400, not 403.
- **A `/docs` batch checks uniqueness within itself too:** two writes in one
  commit claiming the same `unique` value are refused (`400 unique`), and
  nothing is written. Before, both committed.
- **`immutable: true`** makes a collection a log: an identical rewrite is a
  no-op; a different rewrite, or a delete, is refused (409). An upgrade may add
  it but never drop it.
- **An upgrade may not switch `envelope.seq` on or off** for an existing
  collection.
- **A contact-email grant resolves only for a VERIFIED email.** A user who held
  a role only through a contact and signs in with a password loses it. Bind them
  by uid, or have them use Google.
- **`system` is a reserved namespace.**
- **`derive: slug, when: 'absent'`** leaves a supplied value exactly as written.
  It used to re-slugify it on every write.
- **API responses are `Cache-Control: no-store`.** Behind Firebase Hosting, error
  responses used to be CDN-cached across credentials.
- **The platform's own rules can be served as data**
  (`PLATFORM_CONFIGS_FROM_REGISTRY`, off by default). Seed with
  `scripts/seed-registry.js`, and run `--check` before turning it on.
- **Audit an existing host with `scripts/audit-host.js`.** See the beta.3
  "Action required" section: older seeds granted `owner` to a claimable address.

### Security: what was affected

Each of these was a HOST issue. The npm kernel was not affected by any of them.

| Issue | Affected | Fixed |
|---|---|---|
| Seeded role documents granted `owner` to claimable real addresses | hosts seeded from 0.1.0 – beta.2 (remediate with `audit-host.js`) | beta.3 |
| A contact-email grant resolved for an UNVERIFIED email | hosts with password sign-in, 0.1.0 – beta.2 | beta.3 |
| A library named `system` could declare the platform's `system:*` collections | beta.1 – beta.2 | beta.3 |
| Error responses cached by the Hosting CDN across credentials | hosts behind Hosting rewrites, ≤ beta.3 | beta.4 |

### Repository

- **Published through GitHub OIDC with npm staged publishing.** No token
  exists; a maintainer's 2FA approval publishes. The workflow is the shared
  template (`.github/workflows/publish.yml`). It builds the package with
  `build:lib`, and a declared extra install runs after the tarball is packed.
- **Tasks moved to the virta board** (project `tosijs-platform`). `TODO.md` is a
  pointer, and the old contents are in `docs/archive/`.
- **loewald.com serves its own rules from the registry.**
- **`bun seed` seeds the emulator's registry too,** so the emulator matches
  production.

## 0.2.0-beta.5 — 2026-09-26

The platform's own collections can run on the same rules engine as everyone
else's (D19, step 2), behind a switch that is **off by default**. With
`PLATFORM_CONFIGS_FROM_REGISTRY=true`, `post`, `page`, `role`, `config`,
`module` and the install records are served from stored configs in
`system:registry` instead of compiled TypeScript. It is rehearsed on a
production clone and not yet enabled in production.

### Added

- **Platform configs as data.** `scripts/seed-registry.js` writes them (dry
  run by default; `--apply` is one atomic commit of every changed config plus
  an epoch bump; it never deletes; production needs `--production`).
  `--check` exits non-zero unless the stored registry matches the code. Run
  it before enabling the switch anywhere. `system` is reserved, so only
  datastore access can change or fix these rules.
- **Failure is per collection.** A config that is missing or fails to compile
  makes that collection inaccessible; there is no compiled fallback. Missing
  and unknown configs are logged. Role *resolution* does not go through the
  registry, so a broken `role` config never touches anyone's authority.
- **Side-effect hooks by name.** `post`'s cache clear stays in code
  (`collections/hooks.ts`), attached to the loaded config; it is not authority.
- `scripts/bench-registry.js`: interleaved latency, bare-name vs installed.

### Changed

- **The registry refreshes in the background.** Past its 60 s TTL, when the
  epoch confirms nothing changed, it serves the cached rules and reloads
  behind the request. The inline reload was a ~950 ms p99 on a production
  clone. A real change still reloads inline, and concurrent requests share one
  load. A failed background reload keeps the confirmed rules; a failed first
  load still denies everything.
- **`unique` may list several fields, each unique on its own.** This was
  refused as a "composite constraint needing an index", which misread it.
- **Behaviour change for installed manifests: `derive: slug, when: 'absent'`
  now leaves a supplied value exactly as written.** It used to re-slugify it
  on every write. No known consumer relies on the old behaviour.

### Fixed

- **The blog editor moved existing post URLs on save.** It re-slugified every
  path, including an unchanged stored one. A URL-safe path is now kept
  exactly. All 851 production paths are URL-safe, so none moves. This was live
  in production regardless of the switch.
- `getRef`/`getRecords` no longer default to the compiled configs; the map is
  required, so a forgotten call site fails to compile.

### Found by the review before production

The pre-release review (`reviews/0.2.0-beta.5-registry-swap.md`) blocked
this twice, correctly. The stored configs did not match the shipped code in
five ways, any of which the swap would have put live:

- existing post paths rewritten on edit (96 of 791);
- `post/comment` opened, although the code never registers it;
- unlisted pages listed publicly;
- page-path and post-title uniqueness lost;
- looser `module` and `role` schemas. Role contacts are authority.

A behavioural parity test (`seed-parity.isolated.ts`) now runs the real
compiled rules and the stored ones over fixtures for every role and method,
and over schemas. The seeded and compiled collection names are pinned equal.

## 0.2.0-beta.4 — 2026-09-25

One fix, found by the first consumer the day they put the API behind their own
domain.

### Fixed

- **Error responses were CDN-cached across credentials behind Firebase
  Hosting** (#27). A function response with no `Cache-Control` gets
  `max-age=600` from Hosting, and its CDN keys on the URL alone — not on
  `Authorization` — so one caller's `401`/`403`/`404` was served to every
  caller of that URL for ten minutes, and no request header could opt out.
  The worst case is a cached `401` making a client drop a *valid* token.
  The platform API endpoints (`doc`, `docs`, `user`, `hello`, `claim`,
  `install`, `token`, `authorize`) now send `Cache-Control: no-store` on
  **every** response, success included, set before anything else runs. On
  every endpoint, errors sent through the shared writers (`fail()`,
  `notFound()`) and `optionsResponse`'s own 429/403 are `no-store` too. The
  site's SSR endpoints (`prefetch`, `esm`, `sitemap`, `stored`,
  `cachedQuery`) keep CDN caching for their successes. Some of their error
  paths still bypass the shared writers; that is tracked in TODO.md, and none
  of them is part of the platform profile a consumer host deploys.

## 0.2.0-beta.3 — 2026-09-24

A log you can trust. The first consumer (tosijs-virta) found that a sequenced
collection could be silently re-sequenced by an upsert, and silently
truncated by an upgrade. Both are now refused rather than applied. The
pre-release review (`reviews/0.2.0-beta.3-log-integrity.md`) then found three
security holes and a broken verify script, all fixed here.

### ⚠️ Action required on existing hosts

The seed fix below protects hosts seeded **from now on**. A host seeded from an
earlier version, or one the verify scripts have run against, may still carry
grants that anyone can claim — and nothing removes them.

1. **Audit** (read-only; needs this repo and `gcloud` user credentials):

   ```bash
   bun scripts/audit-host.js --alias <alias>
   ```

   It reports **claimable** grants — role documents keyed on the old seed
   addresses (`owner@gmail.com`, `admin@gmail.com`, `writer@gmail.com`,
   `rando@gmail.com`), and FIXED sandbox identities (`sandbox-<role>`, `-pin`)
   whose password was once public — and separately, per-run verify leftovers,
   which are not claimable (random passwords) but worth deleting. Exit 1 means
   claimable grants; 3 means the Auth half could not be listed. Without the
   repo, check `role` documents and Auth users in the Firebase console for the
   same addresses.
2. **Replace before you delete.** If a claimable grant holds `owner` or
   `configurator`, it may be your only path in. Grant that authority to a
   verified identity of yours first and confirm it with `GET /hello`. (The
   audit says when this applies. Deleting first is recoverable — re-run the
   claim ceremony — but needlessly.)
3. **Delete** the claimable entries, then re-run the audit until it is clean.
4. **Check contact-email grants for lock-out.** A role that reaches its holder
   *only* through a contact email now needs a **verified** email (see
   Security). A user who signs in with a password — which never verifies,
   because nothing here sends a verification email — loses it silently. Bind
   such users by uid (`userIds`), or have them sign in with Google.

### Added

- **`immutable: true`** (#25). An identical re-write is a no-op; a different
  one is refused with the new stable code **`immutable`** (`409`), and in a
  `POST /docs` batch the whole commit is refused with it. Creates are
  unaffected; deletes are refused (see Security), and once declared an upgrade
  may not drop it. The field was already in the manifest type and accepted by
  the validator — and compiled to nothing, so a consumer could declare its log
  immutable and every writer could still rewrite it. Without it, an upsert over
  an existing id replaces the document *and assigns a new `_seq`*, moving
  history. Opt-in, like `seq`; a non-boolean value is now refused.

### Security

- **A contact-email role resolved for an UNVERIFIED email** (review M1). Role
  lookup falls back to matching `contacts` by the token's email, and never
  checked `email_verified`. With password sign-in enabled on every provisioned
  host (#17) and a public API key, anyone could create an account under an
  address a role was waiting for — a pre-assigned grant, a clone's owner
  document, or the old seed — and hold those roles. Now the email path is
  taken only when `email_verified === true`.
- **The `system` namespace was not reserved** (review M2). A manifest named
  `system` could declare `system:claim`, `system:host` or `system:seq`, which
  are safe only because nothing registers them — one configurator approval
  from reopening the claim ceremony, marking a consumer's host a sandbox, or
  rewinding a sequence. Refused at install, dropped at registry load, and
  unreachable at lookup.
- **An immutable document could be deleted and re-created** at a fresh `_seq`
  (review M3), which is the rewrite `immutable` exists to prevent. DELETE on an
  immutable collection is now refused with `409 immutable`.

### Fixed

- **An upgrade could switch `envelope.seq` on under stored documents** (#22),
  leaving them with no `_seq` — `since=0` answered "nothing" and a replica
  started from a silently truncated log. An upgrade now refuses turning `seq`
  on *or off* for an existing collection (off silently stops replicas
  receiving). Backfilling in `_created` order was declined: it reintroduces
  the clock ordering `seq` exists to replace.
- **The seed granted `owner` to a real, claimable address** (#23 audit).
  `initial_state` role documents keyed on `owner@gmail.com` et al. meant anyone
  controlling that address could sign in to any host seeded from this repo as
  owner. Seeded roles now grant nothing and use RFC 2606 `.invalid`;
  `seed-safety.test.ts` asserts both.
- **Platform verification could run against a consumer's host** (#23). Hosts
  now record whose they are (`system:host/identity`); every `verify-*.js`
  refuses anything but a marked sandbox and fails closed on an unmarked host.
  Per-run identities, random passwords by default, cleanup keyed on the run.
- `prepublishOnly` printed a wall of expected red on a successful publish; the
  gate is now readable, and the dead shadow-mode scaffolding is deleted.
- **`verify-token.js` revoked a role document that no longer existed** (review
  M4). The grant moved to a per-run id with #23; the script still PATCHed the
  old fixed id, which the REST API silently *creates* — a false red, and a
  stray author+admin grant left behind. It now reads the id from the minter,
  refuses to create on revoke, and deletes the per-run grant when it is done.
- **The emulator integration suites depended on the seeded `owner@gmail.com`**
  and had been passing only because they skip without emulators. They now mint
  their own owner; 53 pass against emulators.

### Contract changes

- New error code `immutable` (`409`), on rewrite and on delete.
- Upgrades that change `envelope.seq` on an existing collection are refused.
- Contact-email role resolution requires a verified email.
- An upgrade may not drop `immutable` from a collection that declared it.
- `system` is a reserved namespace.

### Still open

- **#24** — a hand-written role document without `_created` is invisible to
  role resolution. Write `_created` on any role document you create by hand.

## 0.2.0-beta.2 — 2026-09-21

Everything the first consumer found. Eight issues, all filed within a day of
picking up beta.1, all closed. See [BETA.md](BETA.md) for the current guide.

Verified end to end on the consumer's own host, not only in tests: **94 live
assertions across six ceremonies** (`scripts/verify-*.js`), re-run after every
change. 663 functions + 655 root unit tests.

### Fixed

- **A closed schema rejected every write** (#16 — the blocker). The pipeline
  stamped `_created`/`_modified` and then validated the *stamped* document
  against the caller's schema, so `additionalProperties: false` failed with
  "Unexpected _created" — which is the schema an append-only log wants. Worse
  than the missing feature: the same JSON Schema validated locally accepted a
  document the host refused, so a consumer could not pre-check their own
  writes. The comment above the bug claimed the strip already covered it.
- **`derive: { op: 'principal' }` was compiled with `principal: {}`
  hardcoded**, so it produced `''` for every caller — a declared feature
  wired to nothing. Found while fixing #18, which was the same shape of
  defect.
- **`_by` was promised and never stamped** (#18). BETA.md said "the token is
  the provenance"; nothing was written, so provenance lived only in a field
  the writer chose to populate.

### Added

- **`_seq` and a delta cursor** (#14): `GET /docs?p=…&since=<seq>&c=<n>` →
  `{rows, cursor, more}`. Opt in with `envelope: { seq: true }`. Timestamps
  cannot order a resume — two writes in a millisecond are indistinguishable,
  and the stamps come from the function instance's clock, which drifts — so
  a counter, read and written in the same transaction as the document. A
  total order serialises writes to the collection at roughly one per second;
  that is what a total order *is*, hence opt-in.
- **Atomic multi-document commit** (#15): `POST /docs {writes:[…]}`,
  all-or-nothing, one transaction. An unnamed `method` means upsert. A
  sequenced commit takes a contiguous range, so a replica never sees half of
  one.
- **`_by` provenance on every write**: `{uid, role, name, token?, label?}`,
  unforgeable, hidden from the caller's schema. Every token a person mints
  shares their uid, so the label is what distinguishes one agent from
  another — and from its human.
- **`envelope: { requireAttribution: true }`** refuses a write the endpoint
  cannot attribute.
- **One error shape** (#20): `{error: "<stable code>", message, details?}`
  across the platform routes. Clients switch on the code; the prose is free
  to change. Opaque 404s stay opaque.
- **`GET /install?name=<ns>`** (#19), answerable by any authenticated
  principal including a token — an agent could not previously ask whether its
  own library was installed.
- **`provision-sandbox.js --profile platform`** (#21): a consumer host gets
  the platform routes only — no site functions, no LLM secrets, no blog seed.
- The provisioner enables email/password sign-in, and reports a gcloud
  failure before printing anything, naming `CLOUDSDK_PYTHON` (#17).

## 0.2.0-beta.1 — 2026-09-20

The first release a third party can install onto. See [BETA.md](BETA.md) for the
walkthrough and, more usefully, for what is *not* ready.

Verified end to end against a real deployed host: 64 assertions across three
ceremonies (`scripts/verify-install.js` 27, `verify-token.js` 17,
`verify-authorize.js` 20). 617 functions + 655 root unit tests.

### Added

- **`/install`** — a manifest becomes collection config, schemas and access
  rules. Requires `configurator`, and specifically **not** `owner`: owner's
  power is the datastore (D3), not an in-system bypass. Upgrades are
  additive-only; a published version's content is immutable; revoking
  tombstones the grant and never drops rows.
- **`/claim`** — a fresh host mints its first `configurator` by proving
  datastore write access, with no first-run secret to leak. Rotates on success,
  so it is not replayable and doubles as break-glass recovery.
- **Installed collections reach `/doc` and `/docs`.** Bare names still resolve
  from compiled TypeScript with no extra read, so a live blog's request path is
  unchanged (D18).
- **`/token`** — scoped capability tokens. They attenuate and never grant:
  authority is recomputed live per request, so revoking a human revokes every
  agent they authorised. `owner`/`configurator`/`developer` can never be
  carried; a token cannot mint a token; the secret is never stored.
- **`/authorize`** — a browser loop giving a CLI its first token without anyone
  pasting a secret. PKCE's shape, not OAuth. The browser never receives a
  token; minting happens at the exchange from live roles. Consent page served
  by the function so it cannot desync from the code that processes it.
- `scripts/cli-login.js`, a readable reference client for the above.
- `llms.txt` and `CHANGELOG.md` (#1), and a consumer walkthrough in `BETA.md`.
- Composite indexes for `role.contacts` and `token.hash`.
- `provision-sandbox.js` grants `allUsers` the `run.invoker` role on the public
  endpoints (step 5b), so a freshly provisioned host is reachable without four
  manual `gcloud` calls. Idempotent, grant-only, and it reads even on a dry run
  so the dry run reports what would actually change.

### Fixed

- **The published package could not be imported at all.** `service-compris@0.1.0`
  is `"type": "module"`, and TypeScript under `moduleResolution: "bundler"`
  emitted relative specifiers with no `.js` extension — which Node's ESM loader
  refuses. Installing 0.1.0 and importing it by name fails with
  `ERR_MODULE_NOT_FOUND`. It type-checked, built, tested green, and `npm pack`
  listed every file; nothing exercised the artifact the way a consumer would.
  Fixed by writing `.js` in the source specifiers, and guarded by
  `scripts/verify-package.js`, which packs the tarball, installs it into a
  scratch project, imports it **by package name**, and calls something —
  now part of `prepublishOnly`.

- **`getUserRoles` scanned only the 100 newest role documents** for its email
  fallback, matching client-side. On a host with more roles, a principal whose
  grant fell outside that window silently resolved to anonymous —
  indistinguishable from having no access. Now an indexed query.
- **Revocation by uid was undone by the read path.** The email fallback wrote
  the uid back into `userIds` "for future fast lookups", making it a cache
  wearing a grant's costume: removing a uid was re-granted on the next request,
  by a write that happened during a *read* and so appeared in no audit of
  writes.
- **ID tokens were not checked for revocation.** A revoked or disabled session
  kept full access for up to an hour.
- **`roles[0]` of a two-document query.** A principal granted `author` in one
  role document and `admin` in another got whichever `_created desc` ordered
  first — a nondeterministic answer to "who is this". Roles are now unioned.
- A parked upgrade took the library **offline**: the registry loaded only
  `active` grants, and parking sets `pending`. A safety prompt that causes an
  outage teaches operators to approve without reading.
- Approving a parked upgrade `500`d — approval re-POSTs the same version, and
  `batch.create` rejects an existing document.
- `/install` attributed installs to `userRoles.userIds[0]`, which is a union
  across role documents and could name the wrong person in the ledger.

### Changed

- **Capability manifest shape settled** (#11): a map keyed by namespaced name,
  with `access` rules **inside** each declaration so the existing diff catches a
  widening from `admin` to `public` the same way it catches `maxBytes`
  growing. Unrecognised kinds are refused rather than granted; enforcement is
  not built, and the install response reports `unenforced: [...]` rather than
  implying a live power.
- `lte`/`gte` added to the visibility vocabulary — without them it could not
  express a ceiling, which is the most common capability constraint. They deny
  on type mismatch rather than coercing.

## 0.1.0 — 2026-09-17

Initial publish of the decision kernel, to claim the name.
