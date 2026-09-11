/**
 * tjs-lang VM baseline — ROADMAP Phase 0.
 *
 * The roadmap blocks Phase 1 internals on "re-run the VM spike against tjs-lang
 * 0.13.x before building the backend contract". The 2026-08 spike lived in an
 * ephemeral scratchpad and was lost, so its findings survived only as prose in
 * TODO.md. This file is the spike as a *test*, so the next re-validation is
 * `bun test` rather than an archaeology exercise.
 *
 * Three kinds of assertion live here:
 *
 *  1. RELIED-ON — properties the port depends on. A failure means the foundation
 *     moved; stop and re-derive.
 *  2. REGRESSION — bugs found in the wild, now FIXED upstream, kept forever as
 *     conformance cases so they cannot return silently (tjs-lang#52/#54, fixed
 *     in 0.13.12). This is the ratchet: every interpreter bug found becomes a
 *     permanent case.
 *  3. TRIPWIRE — behaviour still broken upstream, asserted as broken *on
 *     purpose*, so the suite goes red the day it is fixed. §6 holds the one
 *     remaining case. The §4/§5 tripwires fired on 0.13.12 and were converted to
 *     regressions, which is the mechanism working as intended.
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
// HISTORY, kept because the reasoning matters. On 0.13.11 this block claimed the
// predicate model was "unaffected by tjs-lang#52". That was false and it fails
// open: a returned context dot-path yielded the path STRING, and the reference
// RBAC layer ends `allowed: !!result`, so `return doc.published` on an
// unpublished document yielded a truthy string and GRANTED. The cases below
// survived only because each used a shape #52 did not corrupt.
//
// Both are fixed in 0.13.12 (#52, #54 closed; verified 2026-09-11) and are now
// permanent regression cases in §4/§5. §6 holds the one residual.
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

// ── 3. RELIED-ON: transform shapes ─────────────────────────────────────────
// `Object.assign` and bracket access were WORKAROUNDS for #52; since 0.13.12
// spread and dot-path access work too, so these are no longer forced. Kept as
// relied-on because the port uses them and they must keep working — and the
// module.validate oracle below is the end-to-end check that a real transform
// ports correctly, which is the point of the whole file.
describe('relied-on: transform shapes', () => {
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

// ── 4. REGRESSION CASES — tjs-lang#52, fixed in 0.13.12 ────────────────────
//
// These were TRIPWIRES asserting the defect was still present, so the suite would
// go red the day upstream fixed it. It did, on 0.13.12, and the tripwires fired.
// They now assert the CORRECT behaviour and stay forever: every interpreter bug
// found in the wild becomes a permanent conformance case, so it cannot return
// silently. (#52 closed; verified 2026-09-11.)
describe('regression: tjs-lang#52 (fixed 0.13.12) stays fixed', () => {
  test('object spread includes the spread properties', async () => {
    const r = await Eval({
      code: 'const d = { a: 1 }\nreturn { ...d, c: 3 }',
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    expect(r.result).toEqual({ a: 1, c: 3 })
  })

  test('array spread includes the spread elements', async () => {
    const r = await Eval({ code: 'const a = [1, 2]\nreturn [...a]', fuel: FUEL })
    expect(r.error).toBeUndefined()
    expect(r.result).toEqual([1, 2])
  })

  test('spreading a CONTEXT-injected object works', async () => {
    const r = await Eval({
      code: 'return { ...data, c: 3 }',
      context: { data: { a: 1, b: 2 } },
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    expect(r.result).toEqual({ a: 1, b: 2, c: 3 })
  })

  test('returning a context dot-path yields the VALUE, not the path string', async () => {
    const r = await Eval({
      code: 'return doc.owner',
      context: { doc: { owner: 'u1' } },
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    expect(r.result).toBe('u1')
  })

  test('a dot-path via a local yields the value', async () => {
    const r = await Eval({
      code: 'const p = doc.owner\nreturn p',
      context: { doc: { owner: 'u1' } },
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    expect(r.result).toBe('u1')
  })
})

// ── 5. THE FAIL-OPEN CASE — tjs-lang#54, fixed via #52 ─────────────────────
//
// The security consequence that made #52 more than a correctness bug: upstream's
// rule layer ends `allowed: !!result`, so a rule returning a corrupted truthy
// string GRANTED. With #52 fixed, the natural spellings evaluate correctly and
// the fail-open is gone. Kept as a permanent case because it is the shape that
// matters most — a rule that denies must actually deny.
describe('regression: a deny rule denies (tjs-lang#54)', () => {
  const ctx = { doc: { published: false }, published: false }

  const spellings: Array<[string, string]> = [
    ['bare dot-path', 'return doc.published'],
    ['dot-path via a local', 'const p = doc.published\nreturn p'],
    ['bracket access', 'return doc["published"]'],
    ['double negation', 'return !!doc.published'],
    ['explicit comparison', 'return doc.published === true'],
    ['if-guard', 'if (doc.published) { return true }\nreturn false'],
  ]

  for (const [label, code] of spellings) {
    test(`${label} denies an unpublished document`, async () => {
      const r = await Eval({ code, context: ctx, fuel: FUEL })
      expect(r.error).toBeUndefined()
      expect(r.result).toBe(false)
      // the property that actually matters at the RBAC boundary:
      expect(Boolean(r.result)).toBe(false)
    })
  }
})

// ── 6. RESIDUAL: a bare context binding still returns its own name ─────────
//
// Found 2026-09-11 while verifying the #52 fix. `return published`, where
// `published` is a context binding rather than a property access, still yields
// the STRING 'published' instead of the bound value — so it is truthy and would
// still fail open at an RBAC boundary. Narrower than #52 (property access is
// fixed; only the bare-identifier form remains) but the same class.
//
// TRIPWIRE: this asserts the defect. It fails when upstream fixes it.
describe('tripwire: bare context binding still returns its name', () => {
  test('return <binding> yields the identifier, not the value', async () => {
    const r = await Eval({
      code: 'return published',
      context: { published: false },
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    expect(r.result).toBe('published') // BROKEN: should be false
  })

  test('so a rule written that way would still grant', async () => {
    const r = await Eval({
      code: 'return published',
      context: { published: false },
      fuel: FUEL,
    })
    expect(Boolean(r.result)).toBe(true) // the hazard, spelled out
  })

  test('the property-access form is correct, so prefer it', async () => {
    const r = await Eval({
      code: 'return doc.published',
      context: { doc: { published: false } },
      fuel: FUEL,
    })
    expect(r.result).toBe(false)
  })
})

// ── 7. The invariant our host must enforce regardless ───────────────────────
// UNIVERSAL-ENDPOINT.md §4.2: "non-boolean return evaluates as false". Upstream
// coerces with `!!`; we must not. This is belt-and-braces now that #52 is fixed,
// and it is what makes §6's residual harmless at our boundary.
describe('isWriteAllowed: a non-boolean result must deny', () => {
  const interpretRuleResult = (result: unknown): boolean => result === true

  test('true allows; false denies', () => {
    expect(interpretRuleResult(true)).toBe(true)
    expect(interpretRuleResult(false)).toBe(false)
  })

  test('a stray string denies instead of granting', () => {
    expect(interpretRuleResult('published')).toBe(false)
    expect(Boolean('published')).toBe(true) // what `!!` would have done
  })

  test('undefined, null, objects and numbers all deny', () => {
    for (const v of [undefined, null, {}, [], 0, 1, 'true', NaN]) {
      expect(interpretRuleResult(v)).toBe(false)
    }
  })
})
