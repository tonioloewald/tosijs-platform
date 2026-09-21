# Changelog

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
