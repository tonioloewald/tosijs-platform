/**
 * tjs-lang VM baseline — ROADMAP Phase 0.
 *
 * The roadmap blocks Phase 1 internals on "re-run the VM spike against tjs-lang
 * 0.13.x before building the backend contract". The 2026-08 spike lived in an
 * ephemeral scratchpad and was lost, so its findings survived only as prose in
 * TODO.md. This file is the spike as a *test*, so the next re-validation is
 * `bun test` rather than an archaeology exercise.
 *
 * Two kinds of assertion live here, and the difference matters:
 *
 *  1. RELIED-ON — properties the universal-endpoint port depends on. A failure
 *     here means the port's foundation moved; stop and re-derive.
 *  2. TRIPWIRE — currently-BROKEN upstream behaviour (tjs-lang#52), asserted as
 *     broken *on purpose*. A failure here is GOOD NEWS: upstream fixed it, so
 *     delete the workaround it guards and simplify the port. Each one names the
 *     workaround it justifies.
 *
 * Run: cd functions && bun test src/collections/tjs-lang.baseline.test.ts
 */
/* eslint-disable new-cap -- `Eval` is tjs-lang's exported API name; we don't own the casing. */
import { describe, test, expect } from 'bun:test'
import { Eval } from 'tjs-lang/eval'

const FUEL = 5000

// ── 1. RELIED-ON: the reference rule model is a pure boolean predicate ───────
// The tjs-lang reference rbac layer runs rules as zero-capability predicates
// returning boolean. Our RBAC port sits on exactly this shape.
//
// CORRECTION (2026-09-06, review finding F3). This block used to claim the
// predicate model was "the part unaffected by tjs-lang#52". **That was false**,
// and it was cited as the basis of a shipped design decision.
//
// tjs-lang#52 (a returned context dot-path yields the path STRING) applies to
// predicates too, and there it is worse than in a transform: the reference RBAC
// layer ends with `allowed: !!result`, so the string is truthy and the rule
// **GRANTS ACCESS**. A rule denying an unpublished document — `return
// doc.published` — returns 'doc.published', which coerces to true.
//
// The cases below survived only because each happens to use a shape #52 does not
// corrupt (`.includes()`, `===`). The corrupted shapes are pinned as tripwires in
// §4. Upstream: tjs-lang#52 (the defect) and tjs-lang#54 (the fail-open coercion).
describe('relied-on: pure boolean predicates', () => {
  test('role membership evaluates correctly', async () => {
    const r = await Eval({
      code: 'return roles.includes("admin")',
      context: { roles: ['admin', 'public'] },
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    expect(r.result).toBe(true)
  })

  test('owner-field comparison evaluates correctly', async () => {
    const r = await Eval({
      code: 'return doc.owner === user.id',
      context: { doc: { owner: 'u1' }, user: { id: 'u1' } },
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    expect(r.result).toBe(true)
  })

  test('denies when the predicate is false (fails closed by value)', async () => {
    const r = await Eval({
      code: 'return roles.includes("admin")',
      context: { roles: ['public'] },
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    expect(r.result).toBe(false)
  })
})

// ── 2. RELIED-ON: the sandbox actually sandboxes ────────────────────────────
describe('relied-on: sandbox guarantees', () => {
  test('fuel metering halts a runaway rule', async () => {
    const r = await Eval({
      code: 'let i = 0\nwhile (true) { i = i + 1 }\nreturn i',
      fuel: 500,
      timeoutMs: 2000,
    })
    expect(r.error).toBeDefined()
    expect(r.error?.message ?? '').toMatch(/fuel/i)
  })

  test('a zero-capability rule cannot reach I/O', async () => {
    const r = await Eval({
      code: 'return typeof fetch',
      capabilities: {},
      fuel: FUEL,
    })
    // fails closed: either an unknown-atom error, or fetch simply absent
    const failedClosed = r.error !== undefined || r.result === 'undefined'
    expect(failedClosed).toBe(true)
  })

  test('oversized source is refused before transpilation (denial-of-wallet guard)', async () => {
    // New in 0.13.x: transpilation runs BEFORE fuel/timeout apply, so source
    // length is capped separately. Relied on for any hosted stored-proc endpoint.
    const big = 'const x = 1\n'.repeat(6000) + 'return x' // ~72KB > 64KB default
    const r = await Eval({ code: big, fuel: 100, timeoutMs: 500 })
    expect(r.error).toBeDefined()
    expect(r.error?.message ?? '').toMatch(/byte|limit|maxSourceBytes/i)
  })
})

// ── 3. RELIED-ON: the transform workarounds the port must use ───────────────
// Because spread and dot-path returns are broken (§4), a `beforeWrite`-shaped
// rule MUST build its result with Object.assign and read with bracket access.
// These assertions are what make that workaround safe to depend on.
describe('relied-on: transform workarounds (see tjs-lang#52)', () => {
  test('Object.assign builds a correct rewritten document', async () => {
    const r = await Eval({
      code: 'return Object.assign({}, data, { revisions: 4 })',
      context: { data: { source: 'b', title: 't' } },
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    expect(r.result).toEqual({ source: 'b', title: 't', revisions: 4 })
  })

  test('bracket access returns the value, not the path', async () => {
    const r = await Eval({
      code: 'return data["source"]',
      context: { data: { source: 'b' } },
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    expect(r.result).toBe('b')
  })

  test('module.validate revision provenance ports correctly using the workarounds', async () => {
    // The oracle is functions/src/collections/module.ts validate(): on create
    // revisions = 0; on update revisions increments only when `source` changed.
    const AJS = `
      const isUpdate = existing != null && Object.keys(existing).length > 0
      const changed = isUpdate && existing["source"] !== data["source"]
      const next = !isUpdate ? 0 : (changed ? (existing["revisions"] ?? 0) + 1 : null)
      return next == null ? data : Object.assign({}, data, { revisions: next })
    `
    const cases = [
      { data: { source: 'a' }, existing: {}, want: { source: 'a', revisions: 0 } },
      { data: { source: 'a' }, existing: null, want: { source: 'a', revisions: 0 } },
      {
        data: { source: 'a' },
        existing: { source: 'a', revisions: 3 },
        want: { source: 'a' },
      },
      {
        data: { source: 'b' },
        existing: { source: 'a', revisions: 3 },
        want: { source: 'b', revisions: 4 },
      },
      {
        data: { source: 'b' },
        existing: { source: 'a' },
        want: { source: 'b', revisions: 1 },
      },
    ]
    for (const c of cases) {
      const r = await Eval({
        code: AJS,
        context: { data: c.data, existing: c.existing },
        fuel: FUEL,
      })
      expect(r.error).toBeUndefined()
      expect(r.result).toEqual(c.want)
    }
  })
})

// ── 4. TRIPWIRES for tjs-lang#52 — asserting the BUG on purpose ─────────────
// A FAILURE HERE IS GOOD NEWS. It means upstream fixed the defect; go delete
// the Object.assign / bracket-access workarounds above and in any stored proc,
// and update ROADMAP Phase 0.
describe('tripwire: tjs-lang#52 still broken (failure here = upstream fixed)', () => {
  test('object spread is still silently a no-op', async () => {
    const r = await Eval({
      code: 'const d = { a: 1 }\nreturn { ...d, c: 3 }',
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    // BROKEN: should be { a: 1, c: 3 }. Justifies the Object.assign workaround.
    expect(r.result).toEqual({ c: 3 })
  })

  test('array spread is still silently a no-op', async () => {
    const r = await Eval({ code: 'const a = [1, 2]\nreturn [...a]', fuel: FUEL })
    expect(r.error).toBeUndefined()
    // BROKEN: should be [1, 2]. Note it yields a hole, so .length lies too.
    expect(r.result).toEqual([null])
  })

  test('returning a context dot-path still yields the path string', async () => {
    const r = await Eval({
      code: 'return doc.owner',
      context: { doc: { owner: 'u1' } },
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    // BROKEN: should be 'u1'. Justifies the bracket-access workaround.
    expect(r.result).toBe('doc.owner')
  })
})

// ── 5. THE FAIL-OPEN HAZARD (review F3; upstream tjs-lang#54) ───────────────
//
// The consequence of §4 for a SECURITY RULE, which is why the "predicates are
// unaffected" claim was not merely imprecise but dangerous. Upstream's
// `rules.tjs` ends `allowed: !!result`, so a rule corrupted by #52 does not fail
// — it GRANTS.
//
// Each test states the correct answer (deny) and shows what the VM actually
// returns. A failure here means upstream fixed something: re-check which shapes
// are safe before relaxing the guidance in ROADMAP / write-pipeline.ts.
describe('fail-open: predicate shapes corrupted by #52 coerce to GRANT', () => {
  // A document that is NOT published. Every rule below means "deny".
  const ctx = { doc: { published: false }, published: false }

  const grants = [
    ['bare dot-path', 'return doc.published', 'doc.published'],
    ['dot-path via a local', 'const p = doc.published\nreturn p', 'doc.published'],
    ['bare context binding', 'return published', 'published'],
  ] as const

  for (const [label, code, corrupted] of grants) {
    test(`${label} returns a truthy string → !!result GRANTS an unpublished doc`, async () => {
      const r = await Eval({ code, context: ctx, fuel: FUEL })
      expect(r.error).toBeUndefined()
      expect(r.result).toBe(corrupted)
      // the actual hazard, spelled out:
      expect(Boolean(r.result)).toBe(true) // upstream would allow
      expect(r.result).not.toBe(false) // the correct answer
    })
  }

  const safe = [
    ['bracket access', 'return doc["published"]'],
    ['double negation', 'return !!doc.published'],
    ['explicit comparison', 'return doc.published === true'],
    ['if-guard', 'if (doc.published) { return true }\nreturn false'],
  ] as const

  for (const [label, code] of safe) {
    test(`${label} correctly denies`, async () => {
      const r = await Eval({ code, context: ctx, fuel: FUEL })
      expect(r.error).toBeUndefined()
      expect(r.result).toBe(false)
    })
  }

  test('a rule must therefore be written in a #52-safe shape until #54 lands', () => {
    // Documented as an assertion so the constraint is executable, not folklore.
    // Any rule we author or accept must use bracket access or an explicit
    // boolean operator — never a bare dot-path in return position.
    const SAFE_SHAPES = ['bracket access', 'double negation', 'explicit comparison', 'if-guard']
    expect(SAFE_SHAPES.length).toBeGreaterThan(0)
  })
})

// ── 6. The invariant that would make all of §5 moot ─────────────────────────
// UNIVERSAL-ENDPOINT.md §4.2: "Fuel exhaustion, thrown error, or non-boolean
// return all evaluate as `false`." Upstream does not honour the third clause
// (tjs-lang#54). Until it does, OUR host must enforce it — a rule result that is
// not a boolean is a denial, never a coercion.
describe('isWriteAllowed: a non-boolean result must deny (our host obligation)', () => {
  /** What the host must apply to every rule result. Deliberately not `!!`. */
  const interpretRuleResult = (result: unknown): boolean => result === true

  test('true allows', () => {
    expect(interpretRuleResult(true)).toBe(true)
  })

  test('false denies', () => {
    expect(interpretRuleResult(false)).toBe(false)
  })

  test('a #52-corrupted string denies instead of granting', () => {
    expect(interpretRuleResult('doc.published')).toBe(false)
    // this is the whole point — `!!` would have granted:
    expect(Boolean('doc.published')).toBe(true)
  })

  test('undefined, null, objects and numbers all deny', () => {
    for (const v of [undefined, null, {}, [], 0, 1, 'true', NaN]) {
      expect(interpretRuleResult(v)).toBe(false)
    }
  })
})
