# Review: *Libraries as a Service* design doc

> **CORRECTION (2026-09-11).** §1 below uses tjs-lang#52/#54 as its worked example. Both are now
> **closed and fixed in 0.13.12** — verified directly. The *structural* point stands (interpreter
> correctness is a third term the reduction was missing, and v3 adopted it as §5.2); the example is
> now historical. One residual remains: [#56](https://github.com/tonioloewald/tjs-lang/issues/56).
> Elsewhere I described ajs evaluation as "unreliable" — that overstated two specific defects into a
> systemic claim, and is retracted; see the v3 addendum §5.

Reviewed 2026-09-10 from `tosijs-platform`, against a week of concrete evidence in the service
layer. Ownership of the doc is unsettled; this review is filed here because the evidence is here.

Posture: the document is well-scoped and unusually honest about what it does *not* claim (§4.1,
§2's falsifiability framing, §12's enumerated escalations). The notes below are one structural gap,
two additions to a schema §13 says to freeze before it exists, one API requirement, and several
confirmations where I can supply a worked example the doc currently asserts abstractly.

---

## 1. STRUCTURAL GAP — the attestation chain has a silent floor at interpreter correctness

§5 reduces the security claim to **(a)** the host functions exposed and **(b)** capability-check
logic in a small readable interpreter, "auditable by reading, not by auditing a compiler."

There is a **(c)**: the interpreter must *evaluate correctly*. That is not established by
readability, and it is not covered by anything else in the trust architecture.

Worked example from this repo, this week:

- `tjs-lang` 0.13.11 evaluates object and array spread as a **silent no-op**: `{...d, c:3}` yields
  `{c:3}`, `[...a]` yields `[null]`. No error. ([tjs-lang#52](https://github.com/tonioloewald/tjs-lang/issues/52))
- Returning a context dot-path yields the **path string**: `return doc.published` on
  `{published: false}` yields `'doc.published'`.
- The reference RBAC layer ends `allowed: !!result`. A non-empty string is truthy. **So a rule
  written the obvious way to deny an unpublished document grants access.**
  ([tjs-lang#54](https://github.com/tonioloewald/tjs-lang/issues/54))

Now run that through this document's machinery. The artifact is immutable and hash-matched. The AST
is readable and is exactly what executed. Execution is deterministic, gas-metered, replayable. The
attestation is honest, signed, and reproducible — **and every layer faithfully attests the wrong
answer.** Replay proves *same result*, never *right result*. A rule that fails open under a language
defect is invisible to immutability, attestation, verification and replay alike, because none of
them evaluate meaning.

This matters more here than in a conventional stack, because §5.1 deliberately concentrates
trust: deleting the environment is exactly right, but what remains is one interpreter whose
correctness the whole edifice now rests on. That is a *good* trade — one defended surface beats
thousands — but the document should say that (c) exists and name how it is defended, rather than
implying (a) and (b) exhaust it.

Two things worth stating, neither expensive:

- **The interpreter needs a conformance suite that is itself a versioned, attested artifact**, with
  the same status as the harness (§4.5). "Interpreter version" is one of the four hashable facts in
  §5.1; it deserves the same falsifiability treatment as everything else — a hash you can point at
  *and* a passing conformance attestation, not a version number alone.
- **Note the honest limit:** #52 survived multiple releases and was not caught by reading. It was
  caught by an oracle test — porting a known-good TS implementation to ajs and diffing outputs
  case-by-case. Readability is necessary and demonstrably not sufficient.

*Local mitigation, offered as a pattern:* `functions/src/collections/tjs-lang.baseline.test.ts` holds
**tripwires that assert the defect is still present**, so the day upstream fixes it the suite goes
red and tells us to delete the workaround. A defect you have designed around needs a test that
fails when it is fixed, or the workaround outlives the bug forever.

## 2. §4.2 / §13.5 — the attestation schema must record what did **not** run

§13 asks to freeze reproducibility fields before any attestation exists, on the grounds that it is
cheap now and painful to retrofit. Agreed, and the enumerated fields (artifact hash, harness
version, environment, fixture identity) are the right start. One is missing, and I have the
degenerate case.

Our integration suite was skip-guarded: no emulators → print `[SKIPPED]` → `expect(true).toBe(true)`.
For months it reported **140 pass, 0 fail** while twelve cases had never executed. Nobody was lying;
the *reporting* was, and it was a comfortable lie, which is why it survived. When the emulators were
finally started, those tests found **three real production bugs in about ten minutes**.

An attestation of that state would have been signed, reproducible, honest and worthless.
"Tests passed" and "tests did not run" must not serialize to the same record. So:

- attestations carry **counts, not a verdict**: `passed`, `failed`, **`skipped`**, **`total`**
- a verifier treats **`total === 0`, or `skipped > 0`, as a failed attestation**, not a pass
- if a harness supports conditional skips at all, the *reason* is part of the record

This composes with the §4.5 harness argument: a uniform harness is what makes "how many ran"
comparable across packages at all.

## 3. §4.5 / §13.6 — mutation score is the metric that distinguishes *tests exist* from *tests constrain*

§4.6 correctly says malicious code passes its own tests by construction. There is a quieter failure
the document does not name: **honest code passes tests that do not test it.**

Measured here this week. A reviewer mutation-tested our suite: it deleted shipped production code —
a cache-invalidation call, and an opaque-status change — and the suite stayed **byte-identically
green**. The tests pinned *extracted helpers* in isolation and never asserted that any endpoint
called them. Coverage would have looked fine: those lines execute. They were simply not constrained
by any assertion.

Coverage (§4.5) is checkable but weak — a line can be executed without being asserted on. **Mutation
score is checkable and strong, and this platform can compute it far more cheaply than a conventional
stack can**, precisely because of §5's properties:

- the program *is* an AST, so mutants are generated by walking data structures — no source parsing,
  no build step
- execution is deterministic, so a surviving mutant is a real gap, never flake
- execution is gas-metered, so the combinatorics are *bounded by construction* — the usual objection
  to mutation testing (it is too slow) is answerable here in a way it is not elsewhere

That makes mutation score a natural fit for the attestation schema alongside coverage, and a much
better signal for the §4.3 ladder: "95% coverage" is nearly free to game; "80% of injected mutants
were caught" is not. I would put this in §13.6's differential-harness work rather than treating it
as a separate programme — it is the same machinery pointed at the tests instead of at two
implementations.

## 4. §6.2 — option 1's fallback needs a truncation signal in the contract

We implemented per-document predicate evaluation on list reads this week and hit a consequence the
section does not mention.

The doc names option 1's costs as O(n) and a result-set-size timing side channel. Both real. The
third is an API-shape problem: **the limit and the filter interact.** Applying `.limit(n)` and then
filtering returns fewer than `n` while more exist — we were returning 3 of 10 requested. Wrong
answer, silently. Filtering before the limit is correct, but then the scan is *unbounded* for a
selective predicate, so it needs a cap — and the moment there is a cap, **"we stopped looking" and
"there is nothing more" become indistinguishable in the response.**

So the abstract-interpretation fallback in option 3 is not purely an internal performance detail:
whenever evaluation falls back to per-document, the response contract must be able to say
*"truncated by scan bound"* distinctly from *"exhausted"*. That belongs in the endpoint contract the
consumer pins (§6.1), not in a log line. It is the same principle §10 applies to warnings — the
difference between not-looking and nothing-there must be representable — applied to a result set.

## 5. §10 — one refinement: never block the *dev loop*; the *release gate* is different

Strong agreement that gating warnings builds the straitjacket, and warnings-as-versioned-artifacts
with queryable staleness is better than any linter. One distinction worth adding, because it
preserves the ethic while removing the wallpaper failure:

**Warnings never block iteration. A release gate may still refuse.** "Owners take care of
themselves" is intact — the owner can override at the gate, deliberately and visibly, and the
override is itself an artifact. What that buys is that "the platform warned about this in March"
cannot quietly become "and nobody read it in November". Our skipped-tests case is the same shape:
requiring a build in the dev loop is hostile; letting a release proceed on tests that never ran is
worse.

## 6. Confirmations, with worked examples the doc currently asserts abstractly

- **§3.1 (two copies in one page)** is not theoretical. We hit it with `@codemirror`: a duplicate
  copy meant identity-keyed extensions were **silently dropped** (a UI feature simply never
  appeared), and after a version bump it escalated to a hard crash — "Unrecognized extension value…
  multiple instances of @codemirror/state". The silent phase cost far more than the crash. This is
  good supporting evidence for blueprints/consumer-owned tag names being a *marketable* advantage
  rather than a nicety, and worth a sentence: the failure is silent before it is loud.

- **§7.3 (refuse to activate v2 until a transform covers the delta)** — endorsed, with a caveat.
  Two live bugs here were **schema/transform ordering**: a collection whose schema *required* a
  field that only the transform supplies (validation runs first ⇒ creation impossible), and another
  whose schema rejected the provenance fields the endpoint stamps *before* validation ⇒ every write
  failed. Both were invisible for months. Note that neither would be caught by "a transform covering
  the delta exists" — the delta was covered; the *ordering* was wrong. The activation gate should
  verify that a schema-valid document is **actually producible by the write path**, not merely that
  a transform exists. Round-tripping the corpus (which §7.3 already proposes) catches this if it
  runs through the real write pipeline rather than the transform alone.

- **§11 (root authority)** matches what we settled independently here and recorded as D3: the true
  root is whoever holds datastore access; inventing an in-band authority beneath it creates a second
  root under an existing one. Your framing — detection cost and honest accounting, CT as the
  precedent — is better than ours and I would adopt the language.

- **§4.5 (standard harness as the load-bearing insight)** — agreed, from the failure side. Ours is
  not uniform: it needs a build, emulators, and a seed step, which is precisely *why* it silently
  did not run for months. The claim is stronger than "avoids jest-vs-vitest archaeology": uniformity
  determines whether a test can run **without ceremony**, and a test with ceremony is a test that
  eventually stops running.

## 7. Smaller notes

- **§7.4 hermeticity** pins fixture identity as schema version + seed hash. For ajs services the
  interpreter version already covers the runtime, which is a genuine advantage over our situation —
  our integration behaviour varies with the `firebase-tools` version, and nothing records which one
  ran. Worth stating explicitly as a benefit of §5.1, since it is easy to miss.
- **§9's cost-vs-meaning distinction** is the sharpest single idea in the document and the
  differential-equivalence test makes it enforceable rather than aspirational. No notes.
- **§14** is the right first ship.
