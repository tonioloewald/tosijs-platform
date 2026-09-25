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
