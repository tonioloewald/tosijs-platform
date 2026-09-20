# service-compris beta — standing up a host and installing onto it

**This release exists to be broken.** It is the first version where a third party
can take a blank Firebase project, deploy this repo onto it, claim it, install a
library, and give an agent its own identity — without anyone handing over a
secret or deploying a function per feature.

Every flow below is verified end to end against a real deployed host on each
change (`scripts/verify-*.js`, 64 assertions). That is not the same as *used*,
which is what this beta is for.

---

## 1. Stand up a host

```bash
git clone https://github.com/tonioloewald/tosijs-platform
cd tosijs-platform && bun install
# point .firebaserc at YOUR project, then:
bun run initial-deploy
```

Two operational things that will bite you otherwise, both learned the hard way:

**Deploy indexes before functions.** `getUserRoles` resolves a first-time
sign-in by querying `role.contacts`, which needs a composite index. Without it
the query throws and **every sign-in 500s for anyone not already in a role
document** — including, notably, not you, because your own uid is in one.

```bash
firebase deploy --only firestore:indexes   # first
firebase deploy --only functions           # then
```

**New functions are not publicly invocable by default.** A freshly deployed
`claim`, `install`, `token` or `authorize` answers `401` with an HTML body from
Google — not from us. Grant each one:

```bash
gcloud run services add-iam-policy-binding <fn> \
  --region=us-central1 --member=allUsers --role=roles/run.invoker --project=<id>
```

"Publicly invocable" is not "publicly authorized" — the function's own RBAC
still runs. The tell that you are looking at *our* 401 rather than Google's:
ours carries `access-control-allow-origin` and `x-ratelimit-*` headers.

---

## 2. Claim it

A fresh host has nobody privileged. There is no first-run secret to leak,
because the proof of ownership is **being able to write the datastore** — which,
per DECISIONS D3, already outranks anything this system can enforce.

```bash
curl https://us-central1-<project>.cloudfunctions.net/claim
# → { "nonce": "…", "writeTo": { "collection": "system:claim", "document": "current", "field": "proof" } }
```

Write that nonce into `system:claim/current` in the `proof` field — Firebase
console, `gcloud`, or admin credentials. `firestore.rules` is deny-all, so there
is no path to that document through the API for anyone.

Then, authenticated with a Google sign-in:

```bash
curl -X POST -H "Authorization: Bearer $ID_TOKEN" .../claim
# → { "ok": true, "granted": "configurator" }
```

The nonce rotates on success, so the ceremony is not replayable — and it is
re-runnable as break-glass if the configurator loses their account.

> If you are scripting this: a Firestore REST `PATCH` **without** `updateMask`
> replaces the whole document and wipes the nonce you are trying to match. Use
> `?updateMask.fieldPaths=proof`.

---

## 3. Write a manifest

A manifest is plain JSON — collections, schemas, access rules. No builders, no
closures, no deployment.

```json
{
  "manifest": 1,
  "name": "virta",
  "version": "1.0.0",
  "collections": {
    "virta:task": {
      "schema": {
        "type": "object",
        "properties": { "title": { "type": "string" }, "state": { "type": "string" } },
        "required": ["title"]
      },
      "unique": ["slug"],
      "derive": [{ "op": "slug", "to": "slug", "from": "title", "when": "absent" }],
      "access": [
        { "role": "public", "read": "ALL", "list": "ALL" },
        { "role": "author", "write": "ALL" }
      ]
    }
  }
}
```

Rules worth knowing before you write one:

- **Collections must be namespaced** `yourname:whatever`. A bare name belongs to
  the platform, always. `:` is the namespace separator — not `/`, which already
  separates sub-collections.
- **`access` is an ARRAY, not a role-keyed object.** Grants are joined as a
  lattice, so order is meaningless; the array makes that explicit. Holding more
  roles never grants less.
- **v1 is declarative only.** A `functions` key is a hard failure, not an
  ignored field — silently dropping the executable half of your manifest and
  reporting success is the worst available outcome. Stored ajs is install v2.
- **Schemas are checked for keywords the validator silently ignores.** If your
  schema uses one, the install is refused rather than accepted-and-unenforced.

---

## 4. Install it

```bash
curl -X POST -H "Authorization: Bearer $ID_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"manifest\": $(cat virta.json)}" .../install
# → { "status": "installed", "name": "virta", "version": "1.0.0", "unenforced": [] }
```

`GET /install` lists what is installed. `DELETE /install?name=virta` revokes.

**Upgrades are additive-only.** Adding a collection or an optional field is
fine. Removing a collection, removing a field, newly *requiring* one, or
changing a unique constraint are refused as migrations rather than guessed at —
the newly-required case would make every already-stored document invalid.

**A published version's content is immutable.** Re-POSTing the same version is
normal (that is how an upgrade gets approved); re-POSTing *different* content
under the same version is a `409`.

**Revoking never drops rows.** The collections become unreachable; the documents
stay. A re-install restores the same library to the same data.

---

## 5. Use it

```bash
# read  (GET/DELETE take ?p=)
curl '.../doc?p=virta:task/abc'
curl '.../docs?p=virta:task&c=20'

# write (POST/PUT/PATCH take the path in the BODY)
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"p":"virta:task/abc","data":{"title":"ship the thing"}}' .../doc
```

Your schema and access rules are enforced from the moment the install commits.
Rule changes propagate to every warm instance within seconds, via an epoch
counter — a revocation does not wait for a cache to expire.

---

## 6. Give an agent its own identity

```bash
bun scripts/cli-login.js --host https://us-central1-<project>.cloudfunctions.net \
  --label "ci × virta" --roles author --collections virta:task
```

Opens a browser, you approve, the token lands in `~/local-secrets/` at `0600`.
Add `--poll` on a machine with no browser — and read the warning it prints.

`scripts/cli-login.js` is a readable reference client, not a package, so you can
reimplement the protocol in whatever language your agent is written in.

**What a token is:** `(principal, caveats)`. Effective authority is recomputed
on **every request** as `rolesOf(principal) ∩ caveats.roles`. So:

- a token never holds what its principal does not hold *right now*;
- **revoking the human revokes every agent they authorised**, instantly, with no
  revocation list and nothing to remember to do;
- `owner`, `configurator` and `developer` can never be carried by a token —
  each is authority over the system itself, and belongs to a human at an
  interactive session, not to a secret in a file;
- a token cannot mint another token;
- `DELETE` is not in the default methods. Ask for it explicitly.

**The token is the provenance.** Its label — machine × repo — travels with every
write it makes, so "which agent wrote this" is answerable from the record rather
than from a field the writer chose to populate honestly.

The secret is shown once and is **never stored** — only a sha256. It is not
recoverable by anyone, including whoever reads the datastore. A lost token is
re-minted, never retrieved.

---

## What is NOT ready

Said plainly, because a beta that oversells itself wastes your time:

| | |
|---|---|
| **Capability enforcement** | The manifest *shape* for capabilities is settled and validated (`blob`, `email`, `sms`, `outbound`, `turn`), but **nothing consults them yet**. The install response reports `unenforced: [...]` so you are never told you have a power you do not. See #11. |
| **Sub-collections in manifests** | A manifest declares one segment. `virta:task/comment` works at runtime but cannot be declared. |
| **Multi-field unique constraints** | Refused in v1 — they need a composite index, which is a deployment, and "install without deploying" is the point. |
| **`docs.ts` query port** | `/docs` still queries Firestore directly; the substrate port (#7) covers writes only. |
| **Stored ajs** | Install v2. Grounded on tjs-lang, re-validated per ROADMAP before anything is built on it. |
| **The 12 universal-endpoint invariants** | Still `test.todo`. They are acceptance criteria, not passing tests — do not read a green suite as covering them. |

## Where to push hardest

The manifest format is the thing most worth breaking. It was designed against
three consumers at once and validated against one; if it cannot express
something your design needs, **that is the bug** — say so rather than bending
virta to fit it. A format weakness discovered now is a comment on an issue; the
same weakness discovered after adoption is a migration.

Issues: https://github.com/tonioloewald/tosijs-platform/issues
