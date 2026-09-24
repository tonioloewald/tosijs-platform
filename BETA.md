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

# Dry run first — it changes nothing and reports exactly what it would do.
bun scripts/provision-sandbox.js --alias mine --project <id> --profile platform
bun scripts/provision-sandbox.js --alias mine --profile platform --apply
```

`--profile platform` gives you the platform routes and nothing else — no
loewald.com functions, no LLM secrets, no seeded blog content. **Your host
starts empty**: roles arrive through the claim ceremony, collections through an
install. Drop the flag only if you want this repo's own site too.

This links billing, enables the APIs, creates Firestore and a web app,
generates the client config, deploys, grants the public invoker bindings, and
seeds. It is idempotent — re-running is safe.

**One step it cannot do:** enabling Google sign-in needs an OAuth client that
Firebase only provisions through console flows. The script prints the exact URL
and stops rather than pretending. Until you click it, nobody can sign in.

(`bun run initial-deploy` is the older path. It predates the invoker-binding
step below, so prefer the provisioner.)

Two operational things that will bite you otherwise, both learned the hard way:

**Deploy indexes before functions.** `getUserRoles` resolves a first-time
sign-in by querying `role.contacts`, which needs a composite index. Without it
the query throws and **every sign-in 500s for anyone not already in a role
document** — including, notably, not you, because your own uid is in one.

```bash
firebase deploy --only firestore:indexes   # first
firebase deploy --only functions           # then
```

**New functions may not be publicly invocable.** A freshly deployed `claim`,
`install`, `token` or `authorize` can answer `401` with an HTML body from
Google — before our code runs at all. `provision-sandbox.js` now grants the
bindings for you (step 5b, idempotent). If you deployed some other way:

```bash
gcloud run services add-iam-policy-binding <fn> \
  --region=us-central1 --member=allUsers --role=roles/run.invoker --project=<id>
```

Note the Cloud Run service name is **lowercase** — `prefetchdata`, not
`prefetchData`.

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

Then, authenticated with a Google sign-in.

**Getting `$ID_TOKEN`.** This has to be a real Firebase ID token — a platform
token (below) will not do, deliberately: claiming is how authority begins, and
it needs a human at a browser. The provisioner deploys hosting, so:

1. open `https://<your-project>.web.app` and sign in with Google;
2. in the browser console: `await fb.auth.currentUser.getIdToken()`

(`fb` is exposed on `window` for exactly this kind of poking.) The token lasts
about an hour.

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

## 4b. Replicating a collection, and committing several documents at once

Two things an event log needs, both opt-in per collection:

```json
"envelope": { "seq": true, "requireAttribution": true }
```

`seq` assigns a monotonic `_seq` at commit, so a replica can resume:

```bash
curl '.../docs?p=virta:event&since=42&c=100'
# → { "rows": [...], "cursor": 57, "more": true }
```

`more` is returned rather than left for you to infer — a server may cap `c`
below what you asked, so **a short page is not the last page.** Timestamps
cannot do this job: two writes in one millisecond are indistinguishable, and
the stamps come from the function instance's clock, which drifts between
instances.

**The cost, so you can decide rather than discover it:** a total order
serialises writes to that collection, roughly one per second, through a single
counter document. That is what a total order *is* — sharding the counter would
restore throughput and destroy the ordering. An append-only log with one writer
is comfortably inside it; a bulk import is not. Hence opt-in.

**Declare `seq` before the first write.** An upgrade that turns it on — or off —
for a collection that already exists is refused: documents written before it
would have no `_seq`, and `since=0` would answer "nothing" while they sit there.
If you need it on an existing collection, install the log under a new name.

**A log should also be immutable.** `seq` promises an order; only `immutable`
promises the order is not rewritten:

```json
"virta:event": { "schema": {...}, "immutable": true, "envelope": { "seq": true }, ... }
```

Re-writing a stored document with identical content is a no-op (so a retried
commit is safe); with *different* content it is refused — `409 {"error":
"immutable"}`, and in a batch nothing is written. Without it, an upsert over an
existing id replaces the document and gives it a **new** `_seq`: every replica
that already folded it now sees the same id at two positions in the order, and
nothing errors. A replica cannot survive re-sequencing, so a collection you
replicate should not allow it. **Deletes are refused too** (`409
{"error": "immutable"}`): delete-then-recreate would land the same id at a fresh
`_seq`, and a replica never hears about a delete through `since=` anyway.
Removing a document from a log (a legal takedown, say) is the host owner acting
on the datastore directly. `immutable` may be added by upgrade, never dropped — the
documents already stored were written under the promise.

A retry that must be a no-op should be a `PUT` or an upsert through `POST /docs`
— an explicit `POST` asserts "not yet" and is refused with `exists` when the
document is already there, identical or not.

Several documents, atomically:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"writes":[{"p":"virta:event/e1","data":{...}},{"p":"virta:event/e2","data":{...}}]}' \
  .../docs
# → { "status": "committed", "written": 2, "results": [{"p":"…","seq":58}, …] }
```

All or nothing: one invalid document and **nothing** is written, not even the
valid ones beside it, and the sequence does not advance. Omit `method` and each
write is an **upsert** — create if absent, replace if present (refused, if the
collection is `immutable`), no-op if identical — which is an idempotent append
with no client bookkeeping. Naming
`POST` or `PUT` keeps the strict guard. Max 100 per commit; the same document
twice in one commit is refused.

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

### Read this before you debug a 404

**A `404` usually means "not allowed", not "not there".** Denials are opaque to
non-privileged callers by design: a protected document and a missing one must
be indistinguishable, or the error code itself becomes a way to enumerate what
exists. Only `admin`/`developer`/`owner` see the real `403`.

So if a request 404s and you are sure the document exists, check in this order:

1. does your token's `collections` caveat cover that path?
2. does the method fall inside its `methods` caveat?
3. does any `access` rule in your manifest grant that role that method?
4. is the collection actually installed — `GET /install`?

Post-authorization errors are *not* opaque, because by then you have already
proved access: `403 document already exists`, `403 cannot update non-existent
document`, and `400` with schema details all say what they mean.

### The rest of the request surface

| | |
|---|---|
| `/docs?p=…` | `c` limit (default 10), `f` comma-separated fields, `o` order — `o=date(desc)` |
| `field=value` lookups | `/doc?p=virta:task/slug=ship-it` — only for fields in `unique` or `tagFields` |
| sub-collections | `virta:task/abc/comment/xyz` works; declaring one in a manifest does not yet |
| reserved fields | `_id`, `_collection`, `_path` are stripped from writes. `_created`, `_modified`, `_seq`, `_by` are endpoint-managed — stamped on the document and **hidden from your schema**, so `additionalProperties: false` works. You cannot set them. |
| provenance | every write carries `_by: {uid, role, name, token?, label?}`. Unforgeable. All of one person's agents share a `uid` — the token **label** is what tells them apart, and from their human. |
| errors | `{"error": "<stable code>", "message": "<prose>", "details"?: […]}`. Switch on `error`; the prose may be reworded. Opaque `404`s carry no detail by design. |
| rate limit | 100 requests/minute per IP, `429` with `Retry-After`. A bulk import needs to pace itself. |
| unchanged writes | a PUT whose content matches returns `200 unchanged …` and does **not** re-stamp `_modified` |

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
