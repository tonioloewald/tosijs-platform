# Review: *Libraries as a Service* — v3 addendum

Companion to `2026-09-10-libraries-as-a-service-review.md` (which reviewed v2). v3 absorbed that
review substantively — §5.2 now exists, §4.2 carries both attestation fields, §7.3 gates on
producibility rather than existence, §6.2 option 1 carries the truncation requirement, §3.1 has the
`@codemirror` evidence. No notes on any of those; they landed better phrased than I filed them.

This addendum covers **new material in v3** plus one tension between the document and the current
state of the service layer.

---

## 1. Where the strongest new claim needs a scope clause

§2's three-layer framing (foundations / elaboration / implementation) is the best addition in v3 —
"their gap is the absence of a target; ours is distance from one, and distance is the kind of error
that ratchets close" is the sentence that makes the whole posture defensible.

One phrase overreaches, and it's worth fixing precisely *because* the document is otherwise
scrupulous about this class of overclaim:

> The foundations are sound: **a perfect implementation of this design would make every stated claim
> true.**

§5.2, three sections later, establishes the opposite for one claim: a conformance suite "catches the
bugs it encodes… (c) is defended by an oracle, not eliminated." There is no perfect implementation of
"the interpreter evaluates correctly", because the defence is inductive rather than deductive. A
perfect *conformance suite* would be one encoding every possible defect, which is not an artifact
that exists.

So either (c) isn't a stated claim — defensible, since §4.1's checkable list carefully doesn't
include it — or the sentence needs a scope clause. Suggested:

> …a perfect implementation of this design would make every **checkable** claim true. Claims that
> rest on an oracle rather than a proof (§5.2's (c)) are bounded by the oracle's coverage, and are
> stated as such.

That costs one word and closes the only gap I can find between the document's ambition and its own
epistemics.

## 2. The best available upgrade to §5.2: conformance by *differential oracle*, not only by cases

§13.6 scopes the conformance suite as "seed corpus (spread, dot-path resolution, truthiness at the
RBAC boundary — the known bug classes first), ratchet process." That is right and insufficient in a
way worth fixing before the suite exists, because the shape is hard to retrofit.

**Case-based conformance catches what it encodes.** The document says so plainly. But the ratchet it
describes is reactive: a bug reaches the wild, is found by some other means, and *then* becomes a
permanent case. The suite's coverage is therefore always the set of bugs someone already found — it
never finds the first instance of a class.

ajs is a JavaScript subset. **For the overlapping subset, JavaScript is an oracle**, and the entire
class of "ajs disagrees with JS where it shouldn't" becomes mechanically checkable:

- generate programs over the shared subset (property-based, or fuzzed over AST shapes)
- evaluate in ajs and in JS
- any divergence is either a defect or a **declared** divergence

Every defect in this stack's history would have been caught by that automatically, with nobody
knowing to look: spread, dot-path-in-return, truthiness at the boundary. None required encoding in
advance; all three are simply "ajs and JS disagree."

The second output is as valuable as the first. ajs diverges from JS **deliberately** in places — no
member assignment, capability restriction, gas-metered halting, `==` semantics. A differential
harness forces those into an explicit allowlist, and *that allowlist is the language's semantic
specification*, maintained by necessity rather than by discipline. It is the same move the document
makes everywhere else: variance goes in an enumerable register rather than living as folklore.

Recommended framing for §13.6: **two-tier conformance.** Differential-against-JS for the shared
subset, catching unknown-unknowns mechanically; case-based ratchet for deliberate divergences,
host-function behaviour, and anything JS cannot adjudicate (gas accounting, capability denial). The
first is where the leverage is; the second is what §5.2 already describes.

## 3. §5.2's blast-radius claim: computable set of *decisions*, not of *consequences*

> replay every attested execution under the fixed interpreter, diff, and the output is the exact set
> of RBAC decisions wrongly granted, tests vacuously passed, and transforms that misfired… the blast
> radius of any interpreter bug is computable, not estimable.

The mechanism is real and the claim is strong. Two scoping notes so it survives contact with an
actual incident:

**(a) Wrong decisions ≠ blast radius.** Replay yields the exact set of *decisions that were wrong*.
It does not yield what was done with the access those decisions granted — what was read, exfiltrated,
or written downstream. That superset is not recoverable by replaying the decision, because the
consequence lived in the caller. This is still an enormous improvement (you get an exact list of
sessions to investigate rather than a guess), but "blast radius" is incident-response vocabulary for
*effects*, and the paragraph currently claims effects while delivering decisions. Suggest:
*"the exact set of wrongly-granted decisions — which converts incident scope from estimation to
enumeration, and reduces the remaining forensics to what those grants were used for."*

**(b) Replay-over-history has a retention cost the document doesn't name.** "Replay every attested
execution" presupposes retaining inputs at sufficient fidelity, for the whole period the buggy
interpreter was live. That is a storage cost (§3.3 names CDN economics; this is the same genre) and
a **data-protection** question, since execution records contain the data that flowed through — for
an RBAC decision, that includes principal identity and document contents. A ledger that makes
incidents enumerable is also a ledger that must itself be governed. Worth a line, because the
document is otherwise rigorous about naming costs, and this one lands in §12's multi-tenant column.

## 4. "No security issues found in the wild" — the honest version is the stronger one

§5.2's closing production record reads as a track record. By the document's own standard (§5.1:
"hardened" is "earned only through hostile eyes"; §12: adversarial testing before third-party
execution), it currently means *no third party has looked*, which is a different statement.

It also undersells the actual evidence. tjs-lang#54 — the RBAC layer coercing `!!result`, so a
`#52`-corrupted rule **grants** — is a genuine fail-open security defect in a shipped interpreter
version. It was not exploited and was found internally, but "no security issues found in the wild"
is doing a lot of work on *in the wild*.

The candid phrasing is more persuasive than the sanitised one, and is the story the document is
actually trying to tell:

> Production record to date: no exploited issues; one fail-open RBAC defect and several evaluation
> defects found through internal development, each re-checked against history and ratcheted into
> conformance before the fix shipped.

That demonstrates the ratchet working, which is the claim §2 stakes everything on. "No issues" is a
weaker claim *and* a more fragile one — it is falsified by the first finding, whereas "found, fixed,
ratcheted, re-checked" is strengthened by it.

## 5. A live tension with §6.1 — *substantially narrowed, see the correction below*

> **Deploy atomicity**: … The versioned-endpoint design solves this *if the RBAC configuration is
> part of the versioned endpoint artifact*, so a client pins the endpoint+policy version it was
> built against. **Policy is not a sidecar.**

**CORRECTION (2026-09-11).** As filed, this section said ajs evaluation was "presently unreliable in
the shapes a transform needs". That was **wrong in wording and is now wrong in fact**, and the
correction matters more than the original point.

*Wrong in fact:* tjs-lang#52 and #54 are **closed, fixed in 0.13.12**. Verified directly — spread
composes, context dot-paths return values, and `return doc.published` on an unpublished document
yields `false`, so the fail-open is gone. Filed 2026-09-05, fixed within a week. One residual remains
(bare context bindings still return their own name — [#56](https://github.com/tonioloewald/tjs-lang/issues/56)),
narrower than #52 and neutralised at our boundary because our host interprets rule results as
`result === true` rather than `!!result`.

*Wrong in wording, which is the part worth owning:* "evaluation is unreliable" is a **systemic**
claim — that the evaluator cannot be trusted. The evidence was **two specific defects**, both silent,
one with a fail-open consequence. Two bugs in a young language, found and fixed inside a week, is a
bug report; "unreliable" reads as an argument against the architecture. Those are different claims
and only the second was supported. A document this careful about scoping its own claims deserved a
scoped one back.

**What survives:** the *structural* observation, independent of any particular defect. This repo's
transform half is compiled TCB, so today the predicate half of policy could be versioned data a
client pins while the transform half ships with a deploy — which is a sidecar, the thing §6.1
forbids. That was **partly** motivated by #52 and is now unblocked by its fix; what remains is
sequencing work, not a language problem. The general form is still worth stating: **§6.1's
deploy-atomicity guarantee requires transforms to be versioned artifacts, so anything that keeps
transforms in compiled code is on that critical path.**

**And the episode is itself evidence for §2 and §5.2.** The defect was found by an oracle test,
filed, fixed upstream in days, and the tripwires guarding it fired automatically the moment the fix
landed — converting themselves into permanent regression cases. That is the ratchet described in
§5.2 working end to end, observed rather than asserted. It is a better advertisement for the posture
than the absence of bugs would have been.

## 6. One place v3 improved on my suggestion

I proposed a dev-loop/release-gate distinction for §10 warnings. v3 didn't take it, and shouldn't
have — because §4.2 solved the real case in the better place. "0 tests ran" is not a *warning* about
quality; it is a **failed attestation**, and putting the check there (a verifier treats
`skipped > 0` as failure) keeps §10's never-block ethic completely intact while removing exactly the
failure mode I was worried about.

Worth noting explicitly because the distinction is load-bearing: **facts about whether a claim is
valid gate; opinions about whether a design is wise do not.** §10 is the second kind. That the
document sorted my concern into the first bucket without being told is a good sign for the taxonomy.
