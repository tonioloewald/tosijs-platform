# What a sovereign platform would cost

*Analysis, 2026-09-12. Not a decision — see [DECISIONS.md](DECISIONS.md) for those. Prompted by:
"what would a sovereign platform (instead of Firebase) cost us, assuming the smallest, simplest,
cheapest, most robust set of capabilities for someone who just wants to stand up a complete system
on a commodity server."*

## 1. The dependency surface, measured

Not estimated — counted, from the current tree:

| Firebase surface | uses | what for |
|---|---|---|
| `admin.firestore()` | 4 | all document I/O |
| `admin.auth()` | 3 | `verifyIdToken`, `getUser`, `setCustomUserClaims` |
| `admin.storage()` | 1 | one bucket handle for `/stored` |
| `firebase-functions/v2/https` | 11 | `onRequest` wrappers |
| `firebase-functions` | 10 | `logger`, `defineSecret` |

Firestore query features actually exercised: `where` ×5, `orderBy` ×5, `limit`, `select`,
`startAfter`, one `.stream()`, one `db.batch()`. **Zero composite indexes.** **No `runTransaction`
anywhere.**

Auth: **Google sign-in only, no passwords** — no password storage, no reset flow, no verification
email, therefore no deliverability problem. `setCustomUserClaims` is explicitly commented as
"nice-to-have for storage rules; log but don't fail", so it is not load-bearing.

Data volume: **5.5 MB** total, 849 posts.

That is the whole coupling. It is much smaller than it feels, because the platform has been moving
toward stored procedures anyway — §5.1's "the unsafe context shrinks to the host functions that touch
metal" is already most of the way to a portability statement.

## 2. What replaces what

| Firebase | Sovereign | Honest difficulty |
|---|---|---|
| Firestore | **Postgres** (JSONB documents) | Easy, and *strictly better* — see §4 |
| Cloud Functions | **one process**: the ajs host | Easy — already the architecture (§5.1) |
| Hosting + rewrites | **Caddy** | Easy; auto-TLS is a solved problem |
| Cloud Storage | **filesystem**, or S3-compatible if it ever matters | Easy at 5.5 MB |
| Cloud Logging | **stdout → journald** | Easy |
| `defineSecret` | **env file, mode 0600** (or sops/age) | Easy |
| Firebase Auth | **OIDC authorization-code flow against Google + own session JWT** | Moderate, and much smaller than usual because there are no passwords |

Auth is normally the reason not to leave, and normally that is right — password storage, reset
flows, and *email deliverability* are where self-hosted auth hurts. None of those apply here. What
remains is: run the OIDC code flow against Google, verify their ID token against Google's JWKS,
issue a session token signed by our own key. Well-trodden protocol, small surface, no novel
cryptography.

**Total runtime: two processes and a reverse proxy.** `ajs-host`, `postgres`, `caddy`.

## 3. What it costs

**Money: trivially little, and that is not the interesting axis.** A VPS that would run this with
enormous headroom is €5–15/month. At 5.5 MB of data the hardware question is not close.

**The real costs are attention and durability:**

1. **Durability without attention is what cloud actually sells.** One box is one disk. Sovereign
   durability means WAL archiving to off-box storage plus a *tested* restore — and this repo is
   direct evidence of how that goes wrong: until last week there was no restore path at all, and the
   backup script had never been demonstrated to restore. Managed Postgres (~$20/mo) buys most of this
   back without giving up the rest.
2. **Availability during maintenance.** Firebase: invisible. One box: a reboot is downtime unless
   you do blue-green, which is a second box and real complexity.
3. **Abuse absorption.** Cloudflare in front, free tier. Not hard, but it is a thing to remember
   rather than a thing that is simply true.
4. **Operator attention, continuously.** This is the cost that does not show up in a table.

## 4. What it buys — including two things that fix current defects

Beyond independence, sovereignty is *architecturally better* here, not merely cheaper:

- **Real transactions fix a live correctness bug.** The uniqueness check in the write pipeline is
  read-then-write with no transaction — genuinely racy under concurrent writes. Postgres makes it
  sound by construction with a `UNIQUE` index, and the check disappears from application code
  entirely. We are currently emulating in application logic what a database does correctly.
- **The environment becomes attestable, which strengthens §5.1's central claim.** The design doc
  says an ajs service's identity is four hashable facts because "there is no environment to drift."
  That is not quite true on Firebase: the Cloud Functions Node runtime drifts under us on Google's
  schedule, and nothing pins it. One ajs host on a pinned OS image is materially closer to the claim
  the document already makes.
- **§6.2's list-query problem gets easier, not harder.** Option 3 (partial evaluation of the
  predicate AST against the query shape) needs a query planner to push predicates into. Postgres has
  one. Firestore gives you index restrictions to fight instead — and `.select()`-before-filter is
  exactly the shape that caused a real bug here last week.
- **Constraints become declarative.** Uniqueness, referential integrity, check constraints — all
  currently application code, all one line of DDL.
- **No index deployment dance, no query-shape restrictions, predictable cost.**

## 5. Where I would push back on the framing

The PlentyOfFish argument is directionally right and worth stating carefully, because the
overstated version is easy to dismiss.

What is solidly true: PoF served on the order of a *billion page views a month* on a handful of
servers with a tiny team, around 2007–2009. Commodity hardware has enormous headroom, and most
"cloud scale" architecture is indeed sized for requirements nobody has demonstrated. At 5.5 MB and
849 documents, that is not even a close call here.

Three caveats that matter for a platform vended to *others*:

1. **PoF was one operator's full-time attention.** Markus Frind was not "someone who just wants to
   stand up a system"; he was a full-time operator of that system. The hardware headroom claim is
   about capacity, not about unattended operation, and the target user in the question is defined by
   wanting the latter.
2. **PoF's workload was unusually kind** — read-heavy, cacheable, naturally geo-shardable, no strict
   cross-region consistency. Not every workload is, and the argument is strongest when it names why
   the workload fits rather than citing the headline.
3. **The thing cloud sells that is genuinely hard to replicate is not scale — it is durability and
   availability without attention.** Scale is the part commodity hardware wins; operations is the
   part it does not.

So the honest form of the claim is not "cloud is unnecessary" but **"capacity should follow evidence,
and the evidence here is 5.5 MB"** — which is exactly the framing in the question, and it survives
the caveats intact.

## 6. The smallest sensible out-of-box set

For "stand up a complete system on a commodity server", the capability set that earns its place:

| capability | provided by | why it is in the minimum |
|---|---|---|
| document store + queries + constraints | Postgres | the one irreducible dependency |
| identity | OIDC against an external IdP | avoids passwords, reset flows and email entirely |
| endpoint runtime | the ajs host | already the architecture |
| static + TLS + routing | Caddy | one binary, auto-certs |
| blob storage | filesystem | S3 only when there is evidence it is needed |
| secrets | file, mode 0600 | a secret manager is a requirement not in evidence |
| backup + **restore** | pg_dump/WAL + a *tested* restore | the one non-negotiable operational piece |
| logs | stdout | anything more is premature |

Deliberately **excluded** until evidence demands them: container orchestration, service mesh,
message queue (Postgres does this), Redis (Postgres does this at this size), separate search
(Postgres FTS), autoscaling, multi-region.

## 7. Where I land

The service layer is **already portable** — that is what D1's "core value" list amounts to, and the
measured surface confirms it. Nothing here argues against sovereignty; two things argue for
sequencing it deliberately:

1. **Do it as part of the ajs host, not before.** Porting to Postgres and porting to the ajs host
   touch the same code. Done together it is one migration; done separately it is two, and the second
   invalidates the first.
2. **The one thing worth doing now is negative:** stop adding Firebase-specific surface. Every
   `admin.firestore()` call added between now and then is migration debt, and the current count is
   four.

The strongest argument for sovereignty is not cost. It is that **the platform's own trust claims get
more true** — the environment stops drifting under the attestation, and the racy uniqueness check
becomes a database constraint. Those are correctness wins, and they happen to come with a €10 bill.

---

# The requested capability set

*Added 2026-09-12: universal endpoint · SQL data · auth with passkeys · functions · sockets — all
under the RBAC design — plus a realtime layer for games.*

Starting point: **there is no realtime surface today.** `src/firebase.ts` has a `listenRecords`
using `onSnapshot`, but `firestore.rules` is deny-all, so a direct client subscription is refused.
It is vestigial code from before everything moved behind functions. No bypass, and no realtime —
a clean slate rather than a migration.

## A. SQL rather than NoSQL — already the reference semantics

This is not a concession; the design doc already says Postgres provides reference semantics (§6.1)
and that "schema-declared queryable fields become generated columns with indexes; everything else is
JSONB" (§6.2). The document model survives intact:

- document body → `JSONB`
- schema-declared queryable fields → **generated columns + indexes**, which makes §6.2's
  "unindexed-query rule is structural" literally true rather than a policy
- `unique` → a `UNIQUE` index, deleting the racy read-then-write check in the current write pipeline
- versioned monotonic sequences → a `BIGSERIAL`, which is what they were emulating

Postgres also absorbs four things that usually become separate infrastructure: job queue
(`SKIP LOCKED`), search (FTS), coordination (advisory locks), and the change feed (below). None of
those need to be in the minimum set.

## B. Passkeys make sovereign auth *easier*, not harder

This is the counterintuitive one and it is worth stating plainly: **WebAuthn removes the parts of
self-hosted auth that are actually hard.**

Self-hosted auth normally hurts because of passwords — storage, rotation, reset flows, and above all
*email deliverability*, which is an operations problem no amount of good code fixes. Passkeys have
none of that. The relying party stores a credential ID and a public key; authentication is a
signature check. There is no shared secret to leak, no reset flow to phish, and no email to deliver.

It is also *less* coupled than OIDC: no OAuth client registration, no IdP round-trip, no third-party
availability dependency, and no "sign in with Google" telemetry attached to every login. An
air-gapped instance can authenticate users.

**What actually needs building:** two ceremonies (registration, authentication), each a challenge
plus a signature verification over stored public keys. `@simplewebauthn/server` is the well-trodden
implementation; the crypto is ECDSA/EdDSA verification that Node does natively.

**The three real costs, named:**

1. **Recovery is the hard part, and it is unavoidable.** Lose every passkey and you are locked out.
   The options are multiple registered credentials (good), printed recovery codes (good), or an email
   fallback — which reintroduces deliverability, so it should be a deliberate choice rather than a
   default.
2. **Passkeys bind to an origin.** A credential registered at `a.example` does not work at
   `b.example`. For a platform where each deployment is its own domain, **each instance is its own
   relying party** — good isolation, but credentials do not port between instances, and a domain
   change is a re-registration event. Worth designing for rather than discovering.
3. **Keep an IdP path anyway.** Google sign-in as a *second* factor-of-convenience costs little and
   covers the device-loss case. Passkey-primary, OIDC-optional is the right default, not
   passkey-only.

## C. Sockets under RBAC — the genuinely hard requirement

Everything else on the list is substitution. This one is new design, because **the current RBAC model
is request-scoped and a socket is not a request.**

### The question that decides the design: *when* is authorization evaluated?

| point | what is decided | cost |
|---|---|---|
| connect | authentication — who is this | once |
| subscribe | may this principal watch this query at all | once per subscription |
| per event | **row visibility** (D5 boolean axis) + **field projection** (D5 schema axis) | per event × per subscriber |
| on role change | does this subscription still hold | on mutation of `role` |

The last row is the one that gets forgotten, and it is exactly the hole the privilege-lifecycle
tests just found in the HTTP path — **on a long-lived connection it is far worse.** An HTTP caller
with revoked roles is wrong for one request; a socket holder with revoked roles is wrong until they
disconnect. A subscription is a standing query, so it must be re-authorized when *either* side
changes: the data (per event) or the principal (on revocation).

### Bounded staleness, declared rather than accidental

Re-resolving roles per message is correct and wasteful. The cheap version:

- every principal's effective roles carry an **epoch**; any write to `role` bumps it
- a socket caches resolved roles plus the epoch it resolved at
- each event compares epochs — an integer check — and re-resolves only on mismatch

Revocation then takes effect within one event rather than at disconnect, and the staleness bound is
**a declared number instead of an accident**, which is the platform's ethic applied to a new surface.

### A subscription is a standing query — same machinery as §6.2

The important structural point: filtering a change feed per subscriber is *the same evaluation* as
filtering a list query, just pushed instead of pulled. So **§6.2's partial evaluator earns its keep
twice.** If the visibility predicate can be partially evaluated against the query shape, it can be
pushed into the change-feed filter and most events never reach most subscribers. If it cannot, you
fall back to per-event evaluation — the same fallback, with the same truncation-signal honesty
requirement (D7).

One cost that must not be hidden: **fan-out is O(subscribers), not O(1)**, because D5's projection
axis means two subscribers can legitimately see *different fields of the same row*. You cannot
broadcast one serialized payload. The available optimisation is to group subscribers by their
**resolved projection** (not by role list — different role sets can resolve to the same projection,
and the same role set to different projections across collections), then serialize once per group.

### Transport and change feed

Postgres `LISTEN/NOTIFY` is the change feed, with its limits stated rather than discovered: an 8 KB
payload cap and no delivery guarantee if nobody is listening. Both are fine because **the payload
should only ever be `(collection, row id, sequence)`** — the host must re-read and apply
per-subscriber projection anyway, so a fat notification would be wasted work *and* an RBAC bypass
waiting to happen. Where at-least-once delivery matters, logical replication is the upgrade, and the
monotonic sequence (§6.1) is what lets a reconnecting client say "everything since N" rather than
resynchronising the world.

### The worked case, and the refinement it forces: a subscription has a *subject*

The Snowfox failure in full: backend batch processing updated **every company record thousands of
times**, and somewhere in the app there was a **company selector** — so the client was subscribed to
all companies and learned about every write.

Note what the selector actually needed: `{id, name}`, for a few hundred companies. A few KB, changing
almost never. What it received was every field of every record, thousands of times, because the churn
was in fields it did not render.

**This breaks the tier model as stated above, and the break is instructive.** Tier 1 (identity) would
*still* have fired on every one of those thousands of writes, because the id did change. Sending
less data per event does not help when the problem is the *number* of events. So the tiers as a
single dial are insufficient: **what you are told about and what you are sent are orthogonal.**

| axis | question | example |
|---|---|---|
| **filter** | which changes are *relevant to me* | "only when `name` changes" |
| **payload** | how much detail to ship when one is | "just the id" |

The company selector wants a narrow filter (`{id, name}`) with a light payload (ids). Under
Firestore both were fixed and maximal, so the cheap thing was simply unavailable and the expensive
thing was the only option.

**The unification: let the projection schema be the subscription's subject.** D5 already gives every
principal a projection — the sub-schema of a collection they may see. If a subscription names a
projection, then one object answers three questions at once:

- **authorization** — you may see exactly these fields (D5, unchanged)
- **filter** — a write notifies you only if it changes *the projected value*
- **payload** — what ships is the projection

So "subscribe to the `{id, name}` view of `company`" makes the batch-processing churn **definitionally
not a change to your subscription**. Thousands of writes produce zero notifications, server-side,
before any fan-out — and with §6.2's partial evaluation the filter can be pushed into the change feed
so most writes never reach the subscription machinery at all.

That also makes the *common case correct by default*: you subscribe to the view you render, which is
the thing you already had to declare for authorization. The abstraction stops leaking storage units
into an app that cares about a list of names.

**One necessary exception, or the rule is unsound.** A change to a field you do *not* project can
still change whether you may see the row at all — a post whose `date` is cleared becomes invisible
even to a subscriber projecting only `{title}`. So the complete rule is:

> notify when **the projected value changed** *or* **visibility changed** (as an add or a remove).

Visibility transitions are not optional and cannot be filtered away; they are the boolean axis of D5
and they are exactly the events a naive "did my fields change?" implementation would drop. Getting
this wrong is a stale-UI bug in the best case and a disclosure bug in the worst.

### Provenance: this design already exists because Firestore froze Snowfox

Worth recording before it is lost, because it changes the status of everything below from *proposal*
to *reconstruction of something that already earned its keep*. ROADMAP's serving model —
`docs.json` plus "ask for updates since timestamp, receive nothing / a delta / a whole fresh copy" —
was **not** designed as an elegant generalisation. It was built to work around Firestore
subscriptions that would **freeze Snowfox for thirty seconds at a time**.

The important part is what that failure was *not*. Thirty seconds is not a bandwidth problem and not
a server problem: it is **main-thread work proportional to change volume**, in a client that had no
way to decline. The SDK materialises changed documents and maintains its local persistence whether
or not the application currently cares, and there is no dial and no backpressure — so a busy
collection, a batch write, or a migration becomes a UI stall.

Two consequences for the tier design, one of which I had underweighted:

1. **The cheap tiers are cheap in *work*, not merely in bytes.** That is where the freeze actually
   lived. Tier 0 costs the client one integer comparison; tier 1 costs a set difference. Framing the
   tiers as a bandwidth optimisation undersells them and would tempt an implementer to "optimise" by
   batching fat payloads, which reintroduces the exact failure.
2. **The protocol needs backpressure, which Firestore has none of.** Tiers alone are insufficient: a
   client sitting at tier 3 on a busy collection can still be buried. The subscriber must be able to
   say *"I am behind"* and have the server coalesce — and the natural coalescing is **degrade a tier**:
   collapse a backlog of deltas into "these ids changed" (tier 1), or into "sequence is now N"
   (tier 0). Because the tiers are nested, dropping down is always sound: the client can recover the
   detail by fetching, and the sequence cursor tells it exactly what it missed.

This is also the strongest form of D13's discipline. The design was not validated by reasoning about
an unbuilt feature; it was validated by a production failure in a real application, and the
generalisation is the same shape that already worked.

### Subscription granularity is a parameter, not a property

Firestore's failure mode is that `onSnapshot` has **one granularity**: you get documents. So the
cost of a subscription tracks *change volume* rather than *what the client is displaying* — a
background tab pays the same as a focused list view, and a one-field edit ships a whole document.
You can be crippled by updates you do not currently care about, and there is no dial.

The fix is to make granularity a **client-declared, runtime-changeable parameter**:

| tier | payload | what the server must evaluate | fan-out |
|---|---|---|---|
| 0 · epoch | "something in your view changed", + sequence | nothing per-subscriber | **O(1)** — one broadcast |
| 1 · identity | ids added/updated/removed | **visibility only** (D5 boolean axis) | O(subscribers), boolean each |
| 2 · field mask | id + *which* fields changed | visibility + mask ∩ projection | O(subscribers) |
| 3 · delta | changed field values | visibility + full projection | O(subscribers) |
| 4 · record | the whole document | visibility + full projection | O(subscribers) — Firestore's only mode |

**This is not only a bandwidth argument — it makes RBAC dramatically cheaper.** Earlier in this
document fan-out is O(subscribers) because D5's projection axis means two subscribers can see
different fields of the same row. That is true *from tier 2 up*. At tier 1 only the **boolean
visibility axis** is needed, so subscribers group trivially by role-set; at tier 0 no per-subscriber
evaluation happens at all and one message serves everyone. **The cheap tiers are cheap precisely
because they need less of the authorization model applied** — which is a nice property to discover
rather than one to engineer.

The tiers map exactly onto D5: a tier is a statement of *how much of the access evaluation you want
performed and shipped*.

**The client changes tier at runtime, because only the client knows what it is doing.** Tab
backgrounded → tier 0. List visible → tier 1, refetch the ids actually on screen. Document open →
tier 3 for that one id. The server cannot infer any of this, which is exactly why Firestore's fixed
choice is wrong rather than merely expensive.

**Two security notes, since granularity changes what leaks:**

- **Tier 1 leaks existence**, so visibility must still be evaluated per id. "Document X changed" told
  to someone who cannot read X discloses that X exists and is being modified. The boolean axis is
  cheap, but it is not optional.
- **Tier 0 leaks activity.** "Something you can see changed" is a traffic-analysis signal about how
  busy your visible set is. Almost certainly acceptable, and it is the same family as §6.2's
  "result-set size becomes a timing side channel" — worth naming rather than discovering.

**Tier 0 does not need a socket.** It is invalidation, and invalidation composes with ordinary HTTP
caching: SSE, long-poll, or even an ETag'd poll can carry "sequence is now N". That matters for the
sovereign story, because persistent connections are the expensive infrastructure — if most clients
live at tier 0 or 1 most of the time, the socket count needed is far smaller than the user count.

**This generalises something already in the design.** ROADMAP's serving model already says
`docs.json` carries a timestamp and the client asks for *updates since* it, receiving "nothing, a
delta, or a whole fresh `docs.json`". That is tiering, invented for the doc corpus. Generalising it
to subscriptions is the same idea applied to arbitrary collections, and the **monotonic sequence**
(§6.1) is already the cursor it needs — which also gives reconnection catch-up ("everything since
N") without resynchronising the world.

**What Firestore gets right and this must not lose:** offline persistence, automatic reconnect, and
the "query result is a live object" mental model. The sequence cursor covers catch-up; the live-object
convenience belongs in the *client library*, built over tier 1 + fetch, rather than in the protocol.
Keeping it out of the protocol is what allows the cheap tiers to exist at all.

## D. Game realtime is a *different capability* — conflating it is the error

Data subscriptions and game networking share a transport and nothing else:

| | data subscription | game realtime |
|---|---|---|
| consistency | must be correct | must be current |
| durability | every event persists | most state should never touch disk |
| loss | unacceptable | routine and expected |
| latency budget | ~100 ms | ~16 ms |
| RBAC evaluation | per event, per subscriber | per **room membership**, once |

Running game traffic through the document write path would be wrong on every row. The right shape
reuses something the design already has: **§7.4's ephemeral collections are game rooms.** A room is
"config with a lifetime" plus a membership list plus a socket group — spin up, play, discard, with
its capabilities scoped to its own ephemeral collection exactly as §8 requires of test fixtures.

RBAC becomes tractable because it moves to the boundary: **authorize at join, then trust within the
room.** Per-message authorization at 60 Hz is not viable and is not needed — the membership check is
the security boundary, and a room's ephemeral collection is the blast radius.

Two constraints worth naming before anyone builds on it:

- **Gas metering caps tick rate.** Authoritative server logic as an ajs procedure is architecturally
  right and bounded by construction — but a metered interpreter walking an AST at 10–100× JIT'd JS
  (§5.1's own number) sets a real ceiling on tick rate × entity count. That is a capability-pricing
  question (§9), and the honest version is to measure it before promising a tick rate.
- **Ephemeral state should be a separate store from documents.** In-process with periodic snapshots,
  not `INSERT` per tick. Postgres is the wrong tool for positions at 60 Hz and the right tool for the
  match result.

## E. Revised minimum set

| capability | provided by | notes |
|---|---|---|
| universal endpoint | ajs host | unchanged |
| data | **Postgres** — JSONB + generated columns | absorbs queue, search, locks, change feed |
| auth | **WebAuthn/passkeys**, OIDC optional | no passwords ⇒ no deliverability problem |
| functions | ajs procedures | unchanged |
| sockets | WebSocket on the ajs host, fed by `LISTEN/NOTIFY` | RBAC per event, epoch-bounded staleness |
| realtime (games) | ephemeral collection + room membership + in-process state | authorize at join, not per message |
| static/TLS/routing | Caddy | unchanged |

Still three processes: `ajs-host`, `postgres`, `caddy`. Sockets and rooms add code, not
infrastructure — which is the test of whether a capability belongs in the minimum.

## F. What I would build first, and why not in that order

The temptation is sockets, because they are the interesting part. The dependency order says
otherwise:

1. **Postgres + the write pipeline.** Deletes the racy uniqueness check, makes constraints
   declarative, and everything below assumes it.
2. **Passkeys.** Independent of the rest, and the current auth is the only remaining hard coupling
   to Firebase.
3. **The epoch mechanism** — in the *HTTP* path first, where it also closes the revocation hole the
   privilege-lifecycle tests found. Sockets then inherit a mechanism that is already load-tested by
   ordinary traffic rather than debuting on the hardest surface.
4. **Sockets**, subscriptions being standing queries over the change feed.
5. **Rooms**, only once there is a game to point at. Everything above has a consumer today; this does
   not, and building it first would be exactly the premature-requirements error the sovereign
   argument is against.
