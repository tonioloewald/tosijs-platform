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
