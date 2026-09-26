# Registry swap: latency measurement (D19 step 2)

**Question:** what does routing `post` through the registry (the deferred bare-name swap) cost a
live read, compared with today's compiled path?

**Method:** `bun scripts/bench-registry.js --alias sandbox` against service-compris-test running
`v0.2.0-beta.4`, with a production clone. The script installs a throwaway `benchreg:post` that
mirrors `post` (same fields, public read and list) and copies one real published post into it.
It then times identical anonymous reads of both, **interleaved**, 80 per target, paced under the
100/min rate limit, after warm-up. Timings are client-observed, from a single residential
connection. The script cleans up afterwards.

| target | p50 | p90 | p99 | mean |
|---|---|---|---|---|
| `/doc` compiled (`post`) | 209 | 275 | 333 | 221 ms |
| `/doc` registry (`benchreg:post`) | 213 | 286 | 952 | 234 ms |
| `/docs` compiled (`post`, c=10) | 262 | 316 | 352 | 269 ms |
| `/docs` registry (`benchreg:post`, c=10) | 211 | 271 | 452 | 224 ms |

## Reading it

- **`/doc` is the fair comparison** (same document, same bytes): **+3 ms at p50, within noise.**
  A cached registry lookup costs nothing measurable.
- **The tail is where the registry shows.** p99 was 952 ms vs 333 ms. With n=80 that is one or two
  requests, which fits the 60 s full reload (manifests plus grants read, compiled) landing on a
  sampled request. It hits one request per instance per minute, plus an epoch read every 5 s.
- **`/docs` is NOT a fair comparison.** `benchreg:post` held 1 document and `post` held 30, with
  draft filtering on list. So "registry faster" here reflects the data, not the path.

## Conclusion

Latency is not what blocks the swap. The questions that decide it are design, not speed:

1. **Where the platform configs live.** `PLATFORM_CONFIGS` has to become seed documents
   somewhere, and D14 says no compiled authority. That covers the collection, and who may write it.
2. **Failure mode.** If a registry load fails today, only namespaced libraries go dark. After the
   swap, `role` and `config` would too, which is the whole site and everyone's authority. That
   needs a stated answer, for example last-known-good snapshot, or refuse to serve, before
   production.
3. **The reload tail.** The fix could be a background refresh, so no request pays it. Or accept it.

---

## Swap rehearsal with the switch ON (2026-09-26)

Code at `e33f4cd`. Sandbox seeded with `seed-registry.js --alias sandbox --apply` (9 configs plus
an epoch bump in one commit). A second run reported all 9 `unchanged`, so the round trip is
exact. Functions were deployed with `functions/.env.sandbox`
(`PLATFORM_CONFIGS_FROM_REGISTRY=true`), and the deploy log confirms the file was loaded.

| Check | Result |
|---|---|
| verify:sandbox (public) | 17/17 |
| verify:sandbox:auth | 17/17 |
| install / batch / sequence / provenance / authorize / token | 27 / 11 / 12 / 7 / 20 / 17 |
| Browser: home and a post | render; no console errors |

**The switch is really on, and failure is per collection.** I deleted `system:registry/post`
(with an epoch bump) and then restored it with `seed-registry.js --apply`:

| | `/doc` post | `/docs` post | `/doc` config/app |
|---|---|---|---|
| before | 200 | 200 | 200 |
| `post` config removed | **404** | **404** | 200 |
| restored by the seed script | 200 | 200 | 200 |

Each change took effect within 8 s. So a missing config makes its collection inaccessible,
other collections are unaffected, and recovery through outside (datastore) privileges works, as
the owner specified.

**Latency with post served from the registry:** p50 `/doc` was 209 ms, the same as the compiled
baseline. p99 was 523–664 ms, down from 952 ms before background refresh. At n=80 a p99 is
about one request, so read this as indicative.

**Seed parity fixed before rehearsal**, both of which the swap would have shipped: `page` LIST
leaked unlisted pages, and `unique` was lost on page `path` and post `title` (`bfad021`).
