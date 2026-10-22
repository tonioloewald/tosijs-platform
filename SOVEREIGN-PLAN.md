# Sovereign host: the plan

*Plan, 2026-10-22. Not a decision: the choices it needs are in [§7](#7-decisions-needed), each with
a default. Builds on [SOVEREIGN.md](SOVEREIGN.md) (the cost and capability analysis, 2026-09-12) and
board epic **#2863** (second host: the JS runtime + a filesystem). Consumers: #3374 (Manta
multiplayer), #1141 (WebRTC), and the planned whiteboard.*

Owner, 2026-10-21: self-host on a VPS or a private box. SQLite first, so it is self-contained, but
the goal is the whole stack on **Firebase**, on **one VPS with SQLite**, or on a **scaled setup**
(load balancer, Postgres, Redis). Build the simple thing; keep the complex thing in mind. The
immediate reason is **realtime**: sockets, WebRTC, maybe UDP, and persistent connections, for
multiplayer games and a shared whiteboard.

## 1. What changed since SOVEREIGN.md

- **SQLite comes before Postgres.** SOVEREIGN.md assumed Postgres. Nothing in its design depends
  on that: the document table, unique constraints, sequences and transactions all exist in SQLite.
  Measured on Bun 1.4.2 / SQLite 3.51 (2026-10-22):
  - one `documents(collection, id, data, seq)` table;
  - a partial unique index per unique field, e.g.
    `UNIQUE (json_extract(data,'$.path')) WHERE collection='post'`;
  - array-contains via `json_each`.

  The index refuses a duplicate post path and allows the same path in `page`. Postgres takes the
  identical layout with `JSONB`, so the later move is a dialect change, not a remodel.
- **Realtime moved from last to first.** SOVEREIGN.md §F ordered sockets 4th and rooms 5th
  "only once there is a game to point at". There are now named consumers (Manta #3374, the
  whiteboard, WebRTC #1141). Rooms do not need the write pipeline or the change feed, so they can
  ship first (see §5). Data subscriptions still wait for the change feed.
- **The coupling grew.** SOVEREIGN.md counted 4 `firestore()` calls; today (2026-10-22, non-test
  sources in `functions/src`):

  | surface | count |
  |---|---|
  | `firebase-admin` imports | 13 files |
  | `.firestore()` calls | 34 |
  | transactions (`commit.ts`, `claim.ts`, `install/endpoint.ts`) | 3 files |
  | `firebase-functions` imports, mostly `logger` | 22 files |
  | `onRequest` endpoints | 17 |

  The ports epic #2863 described (`Store`, `MemoryStore`, the blob `ObjectStore`, the pure write
  pipeline and access model) are real. But `docs.ts`, commits, claims, render and install bypass
  them. SOVEREIGN.md §7 asked to stop adding Firebase surface; that has not held, so this plan
  makes it a test (Phase 1).

## 2. Three shapes, one kernel

| port | Firebase (today) | Single box (first) | Scaled (keep in mind) |
|---|---|---|---|
| **Data**: documents, queries, transactions, counters | Firestore | `bun:sqlite`, WAL, one file | Postgres (same layout, JSONB) |
| **Files**: objects, signed URLs | Cloud Storage | a directory + server-signed URLs | S3-compatible (R2, MinIO) |
| **Auth**: credential → principal | Firebase ID tokens | Google ID tokens verified directly, own session token | same, stateless on every node |
| **HTTP**: `(Request) => Response` | `onRequest`, a thin wrapper | `Bun.serve` | N nodes behind a load balancer |
| **Bus**: "collection X is at seq N", room fan-out | commit hook → realtime node | in-process | Postgres `LISTEN/NOTIFY` or Redis pub/sub |
| **Live**: sockets, rooms | a realtime node beside the host (§5.6) | `Bun.serve` websockets, same process | room-pinned nodes (§3) |
| **Secrets** | `defineSecret` | env file, mode 0600 | the platform's secret store |
| **Logs** | Cloud Logging | stdout → journald | stdout → collector |
| **TLS / static** | Hosting | Caddy | load balancer + CDN |
| **Backup** | `bun run backup` | Litestream to off-box S3 + a **tested restore** | managed Postgres PITR |

The **kernel** is everything that decides: the access model, the registry, the write pipeline,
validation, render-on-store, install, tokens. It imports no vendor SDK and runs on Node (Cloud
Functions) and Bun. **Adapters** are per shape, and only adapters import a vendor.

## 3. Invariants that keep the scaled shape open

The single box can cheat in ways that close the door. These are the rules that keep it open, and
each should be enforced by a test or by the conformance suite, not by memory:

1. **No authoritative in-process state except room state, and a room lives on exactly one node.**
   Caches are caches. A room's id decides its node, so a scaled setup routes by room id (sticky
   routing or a room directory). The single box is the case where every room is on node 1.
2. **The write path publishes through the Bus port, never directly to sockets.** The single-box Bus
   is in-process, but the commit cannot tell, so swapping in Redis or `NOTIFY` changes no caller.
3. **Transaction bodies are retry-safe.** Firestore retries them, and Postgres serialization
   failures must be retried. Side effects happen after commit, as `commit.ts` already does with
   `afterWrite`.
4. **Bus payloads are `(collection, id, seq)`, never document bodies.** Each subscriber's
   projection is applied by re-reading (SOVEREIGN.md §C). A fat payload is both waste and an RBAC
   bypass, and `NOTIFY` caps payloads at 8 KB anyway.
5. **Revocation propagates by epoch, not by an in-process event.** The registry epoch
   (`install/epoch.ts`) already works this way. Roles get the same treatment (§5.4).
6. **Auth verifies statelessly on any node.** No session table on the hot path; token-record
   lookups (`/token`) are Data reads.
7. **Every live stream is resumable from a sequence cursor.** Losing a node means the client
   reconnects and asks for "everything since N", never a resync of the world.

## 4. Data on SQLite

One table, matching D15's logical→physical mapping (`:` is legal in a column value, so namespaced
collections need no renaming):

```sql
CREATE TABLE documents (
  collection TEXT NOT NULL,   -- logical path, e.g. 'post', 'blog:public', 'post/comment'
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,   -- JSON; JSONB on Postgres
  seq        INTEGER,         -- only for sequenced collections
  PRIMARY KEY (collection, id)
);
-- per collection config, generated from `unique` / `tagFields` when the registry changes:
CREATE UNIQUE INDEX u_post_path ON documents (json_extract(data,'$.path')) WHERE collection = 'post';
```

- **Uniqueness becomes a constraint.** The in-transaction read-then-check in `commit.ts` stays for
  Firestore, but on SQLite and Postgres the index is the authority. The racy check SOVEREIGN.md §4
  named goes away by construction.
- **Transactions:** `BEGIN IMMEDIATE`. One writer at a time is SQLite's model, which is plenty for
  a single box. Counters (`system:seq`) are rows in the same transaction.
- **Registry-driven DDL:** when the registry epoch changes, the adapter reconciles the indexes with
  the configs. An index that cannot be created (existing duplicates) is a refused install, not a
  silent skip.
- **Queries:** `docs.ts`'s needs are equality, array-contains, order, limit, cursor and projection.
  All of them are plain SQL over `json_extract`. D7 (filter before limit) stays the caller's job,
  as the `Store.query` doc comment already says.
- **Durability:** WAL mode plus Litestream continuously to off-box S3-compatible storage, and a
  restore that is **run in CI**. SOVEREIGN.md §3 is right that this is the one non-negotiable
  operational piece.

## 5. Realtime

### 5.1 One socket, channels inside it

`/live` is one WebSocket per client, multiplexing channels. JSON control frames, binary frames
allowed for game payloads:

| channel | what | authorized | durability |
|---|---|---|---|
| **room** | relay, presence, WebRTC signaling | at join | none: in memory on the room's node |
| **sub** | standing query over a collection (tiers 0–4) | at subscribe, then per event | the documents themselves |

The two never share a code path past the transport. SOVEREIGN.md §D's table (consistency vs
currency, ~100 ms vs ~16 ms, loss unacceptable vs routine) is why.

### 5.2 A room is a document

Like storage areas (D21), there is no second permission system. A room is a document in a
room collection (platform `room`, or namespaced, e.g. `whiteboard:room`), and its collection's
access rules are the room's:

- **may join** = may read the room document (D5's visibility axis);
- **may send**: the room document's `send` field (`members` | `owner` | `none`, the last for
  broadcast rooms), validated by the collection schema;
- **lifetime:** `expires` on the document, swept like other expiring records. Closing the room
  disconnects its members.

Membership is checked once at join and again whenever an epoch says roles or rules changed
(§5.4). Per-message authorization at 60 Hz is neither viable nor needed, because the room is the
boundary.

Every connection has quotas: messages per second, bytes per second, maximum frame size, members
per room, rooms per principal. They are part of the room collection's config, so a game and a
whiteboard can differ. Without them a public room is an amplifier.

### 5.3 WebRTC

- **Signaling** is just room messages (`offer`, `answer`, `ice`, addressed to a member). This
  replaces #1141 half 1's short-polling of `/docs` with a push, so call setup no longer pays the
  ~1 s polling cost.
- **STUN:** public servers, or coturn on the box.
- **TURN:** coturn on the same VPS, using its time-limited shared-secret credentials
  (`use-auth-secret`). `/live` mints a credential only for a principal that has joined the room,
  with a short TTL. This is #1141 half 2's "brokered capability" in its cheapest form: on a VPS,
  relay egress is usually bundled bandwidth rather than metered cloud egress. Cloudflare Calls
  stays the option for hosts that cannot run UDP.
- **Mesh limit:** past ~4–6 peers, mesh stops working (#1141); an SFU is out of scope until a
  consumer needs it.

### 5.4 Revocation on long-lived connections

SOVEREIGN.md §C: an HTTP caller with revoked roles is wrong for one request, but a socket holder
is wrong until they disconnect. The fix:

- a **role epoch** beside the registry epoch, bumped by any write to `role`;
- each connection caches its resolved roles and the epochs it resolved them at;
- on any epoch change (pushed over the Bus on the single box, polled when scaled), every
  connection re-resolves, then re-checks its rooms and subscriptions;
- a failed check is a **leave event**, not a silent drop.

The staleness bound is then a declared number, as SOVEREIGN.md asks. It should land in the HTTP
path first (it also closes the revocation window there), so sockets inherit something already
tested by ordinary traffic.

### 5.5 Unreliable, UDP-like traffic, honestly

Browsers cannot open raw UDP. The options for "latest state wins, drop the rest":

1. **Peer-to-peer data channels**, configured unordered with `maxRetransmits: 0`. They are UDP
   underneath and cost the server nothing beyond signaling and TURN. This is the first answer for
   relay-style games, and it comes free with §5.3.
2. **Browser ↔ server data channels** need a server-side WebRTC stack (node-datachannel, werift).
   Whether either runs under Bun has not been tested. **Spike** this before promising it; it is
   only needed for a server-authoritative game.
3. **WebTransport datagrams** need an HTTP/3 server. Bun has none today (unverified for the
   current release). Watch it rather than build on it.
4. **Raw UDP** (`Bun.udpSocket`, present in Bun 1.4.2) is for native clients and server-to-server
   links only.

Manta's own suggestion (#3374) fits the order: relay-only rooms first, where clients simulate and
the server relays and adjudicates results through the write pipeline. Authoritative ajs room logic
waits for a measured tick rate (SOVEREIGN.md §D: gas metering caps it).

### 5.6 Realtime for a Firebase host

Realtime does not have to wait for data to leave Firebase. The same Bun server, run with only the
Live and Auth ports, can sit **beside** a Firebase host:

- **Auth:** it verifies Firebase ID tokens offline against Google's public keys (issuer
  `securetoken.google.com/<project>`, audience the project id). Revocation checking needs the
  Admin API, so offline verification is bounded by the ~1 h token life unless the role epoch
  covers it.
- **Data:** it reads room documents and roles through the Firestore Data adapter.
- **Bus:** the commit's `afterWrite` notifies it, or it watches `system:seq` with a server-side
  listener. The Admin SDK is not bound by `firestore.rules`, so this does not reopen the client
  bypass.
- **Hosting:** Cloud Run supports WebSockets (60-minute request cap, so clients reconnect), or the
  same VPS.

This answers #3374's first question: rooms can arrive on a Firebase host as a sidecar, and become
in-process on a sovereign one.

### 5.7 Whiteboard

The platform carries opaque room messages and does not choose a CRDT. Yjs or Automerge rides on a
room as binary frames, and persistence is a periodic snapshot document written through the normal
write pipeline, so the saved board is under the ordinary RBAC. This is the minimal-wrapping
stance: the library's whole API, not a platform imitation of it.

## 6. Phases

Each phase ends deployable and with its exit test green. Phases 3 and 4 can overlap once Phase 2
has landed.

| # | phase | delivers | exit test |
|---|---|---|---|
| **1** | **Ports, no behaviour change** (on Firebase) | Data (`query`, `transaction`, counters) wired into `docs.ts`, `commit.ts`, `claim.ts`, render, install, epoch, blob metadata; Files; Auth; HTTP `(Request) => Response` with `onRequest` as a wrapper; `logger` behind an injected sink, as `setAccessLogger` already is | A test fails if any file outside `adapters/firebase/` imports `firebase-admin` or `firebase-functions`. One **conformance suite** passes against `MemoryStore` and the Firestore emulator. Production deploy is byte-for-byte the same behaviour |
| **2** | **Bun server + SQLite** (`bun run serve:local`) | SQLite Data, directory Files, Google-token Auth plus dev identities, all 17 endpoints on `Bun.serve` | The conformance suite passes on SQLite. **Local development needs no Java emulators.** A `bun run backup` snapshot of loewald.com imports and serves locally |
| **3** | **Live v1: rooms** (on the Bun server) | `/live`, room collection, join/leave/presence, relay, signaling, quotas, TURN credential minting; role epoch in HTTP and Live | A two-browser test: join, relay, signaling to a connected data channel, revocation evicts within one epoch, quota trips. Runs both in-process and as a sidecar to the **sandbox** Firebase host |
| **4** | **Sovereign deploy** | one VPS: `bun build --compile` binary + data dir + Caddy + systemd; Litestream; coturn; D16 claim via a `sqlite3` prompt | A fresh VPS from a script to a claimed host. **Restore from off-box backup is run and checked.** The deploy check (`scripts/deploy.js`'s outside-in probe) passes against it |
| **5** | **Data subscriptions** | `sub` channel, tiers 0–4, projection as subject, visibility transitions, backpressure by tier degradation; tier 0 also over SSE | The Snowfox case as a test: thousands of writes to unprojected fields produce zero notifications; visibility add/remove is never filtered |
| **6** | **Server-side unreliable channels**: spike | §5.5 option 2 under Bun, measured | A go/no-go note with numbers, when a server-authoritative game asks |
| **7** | **Scaled shape**: design check only | Postgres Data adapter, Redis/`NOTIFY` Bus, room routing, S3 Files | The conformance suite passes on Postgres. Not built until a host needs it (D13) |

loewald.com stays on Firebase throughout (#2863). New shapes are proven on the sandbox and on a
VPS of our own.

## 7. Decisions needed

Each has a default I would proceed on. Recorded in DECISIONS.md only when the owner says so.

1. **SQLite before Postgres for the sovereign host.** *Default: yes*, as asked. This amends
   SOVEREIGN.md §E/§F's Postgres-first order.
2. **Auth on a self-hosted host** (#2863's open question). *Default: Google ID tokens verified
   directly plus our own session token on real hosts, and dev identities in local mode only.*
   Passkeys (SOVEREIGN.md §B) next, as their own phase.
3. **Rooms before data subscriptions.** *Default: yes.* Rooms need Auth plus read-only Data;
   subscriptions need the change feed and the Phase 1 ports.
4. **A room is a document; join = read.** *Default: yes* (§5.2, the D21 pattern).
5. **The kernel runs on both Node and Bun**, adapters per runtime. *Default: yes*, so Cloud
   Functions keep working unchanged. The alternative, Bun only, would mean moving Firebase hosts to
   Cloud Run containers.
6. **Relay-first rooms; authoritative ajs room logic waits for a measured tick rate.** *Default:
   yes* (#3374).
7. **Passkeys: recovery is a backup passkey** *(owner, 2026-10-22)*. Synced passkeys are restored
   by their provider (iCloud Keychain, Google Password Manager, 1Password), so losing devices is
   the provider's problem, not ours. What we build:
   - after the first passkey, the account UI asks for a **backup** (ideally from a different
     provider or a hardware key) and shows a warning while there is only one;
   - no recovery codes and no email fallback;
   - admins can attach or remove a user's credentials;
   - the owner's break-glass is the D16 claim ceremony.

   It works on the Firebase host too: after verification, `createCustomToken` hands the client a
   normal Firebase session, so passkeys need not wait for the sovereign host. **A passkey is
   added only while signed in**, so it always attaches to an existing account (owner, same day).
   The backup may be the user's own or a trusted person's ("another of yours or your wife's"):
   whoever holds it can sign in *as you*, so each passkey carries a user-chosen label and a
   last-used time in the account UI, and removing one is one click. **The label is for audit, not
   only display:** the session records which credential signed in, every sign-in is logged with
   it, and write provenance names the credential beside the user. So "who did this" can be
   answered as "you, via the passkey labelled *backup, held by family*". Passkey-only sign-up is a
   separate decision about who may create accounts.

## 8. Risks and unknowns

- **Phase 1 is the long one.** 34 Firestore calls in 13 files, three of them transactions, and the
  render store's compare-and-set. It is also the phase with no visible feature. The mitigation is
  the import-ban test: once it is green, the debt cannot grow back.
- **Cloud Functions are Node, the sovereign host is Bun.** The kernel must avoid Bun-only APIs; the
  conformance suite runs under both.
- **SQLite's single writer.** Fine at blog and room-metadata scale. A bulk import serialises, which
  is already true of sequenced collections on Firestore (`sequence.ts`).
- **Operations is the real cost** (SOVEREIGN.md §3, §5). A VPS reboot is downtime; the plan does
  not pretend otherwise. Blue-green is the scaled shape's job.
- **Abuse:** a public `/live` is a resource an attacker can hold open. Quotas (§5.2), connection
  caps per principal and per IP, and anonymous sockets off by default.
- **Unverified:** server-side WebRTC under Bun, and WebTransport in Bun. Both are named spikes, not
  assumptions.

## 9. Not in this plan

SFU or media servers, an in-house CRDT, multi-region, container orchestration, Redis on the single
box, migrating loewald.com off Firebase, the Rust port (#2864, which depends on this plan's ports
and conformance suite).
