# Changelog

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
- Composite indexes for `role.contacts` and `token.hash`.
- `provision-sandbox.js` grants `allUsers` the `run.invoker` role on the public
  endpoints (step 5b), so a freshly provisioned host is reachable without four
  manual `gcloud` calls. Idempotent, grant-only, and it reads even on a dry run
  so the dry run reports what would actually change.

### Fixed

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
