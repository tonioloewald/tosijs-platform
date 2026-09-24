# Changelog

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
