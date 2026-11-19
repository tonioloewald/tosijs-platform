/**
 * tjs-lang VM baseline — ROADMAP Phase 0.
 *
 * The roadmap blocks Phase 1 internals on "re-run the VM spike against tjs-lang
 * 0.13.x before building the backend contract". The 2026-08 spike lived in an
 * ephemeral scratchpad and was lost, so its findings survived only as prose in
 * TODO.md (now docs/archive/TODO-2026-09-26.md). This file is the spike as a *test*, so the next re-validation is
 * `bun test` rather than an archaeology exercise.
 *
 * Three kinds of assertion live here:
 *
 *  1. RELIED-ON — properties the port depends on. A failure means the foundation
 *     moved; stop and re-derive.
 *  2. REGRESSION — bugs found in the wild, now FIXED upstream, kept forever as
 *     conformance cases so they cannot return silently (tjs-lang#52/#54, fixed
 *     in 0.13.12; the bare-binding return and #59, fixed in 0.14.0). This is
 *     the ratchet: every interpreter bug found becomes a permanent case.
 *  3. TRIPWIRE — behaviour still broken upstream, asserted as broken *on
 *     purpose*, so the suite goes red the day it is fixed. None remain on
 *     0.14.0: the §4/§5 tripwires fired on 0.13.12 and the §6 ones on 0.14.0,
 *     and each was converted to a regression, which is the mechanism working
 *     as intended.
 *
 * Pinned to an exact version (functions/package.json): a new tjs-lang is
 * adopted by re-running this file, not by a semver range moving underneath it.
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
// permanent regression cases in §4/§5. The last residual (§6) is fixed in 0.14.0.
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
    // The default limit was 64 KB through 0.13; it is 8 KB from 0.14.0.
    const big = 'const x = 1\n'.repeat(800) + 'return x' // ~9.6 KB > 8 KB default
    const r = await Eval({ code: big, fuel: 100, timeoutMs: 500 })
    expect(r.error).toBeDefined()
    expect(r.error?.message ?? '').toMatch(/byte|limit|maxSourceBytes/i)
  })

  // 0.14.0 (#3986): before it, a deadline could not interrupt a run that only
  // computes, so fuel was the only real limit.
  test('timeoutMs stops a run that only computes', async () => {
    const started = Date.now()
    const r = await Eval({ code: 'let i = 0\nwhile (i < 100000000) { i = i + 1 }\nreturn i', fuel: 1e12, timeoutMs: 200 })
    expect(r.error?.message ?? '').toMatch(/timeout/i)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  // 0.14.0: an undeclared name is a transpile error. On 0.13.12, `return nope`
  // returned the string 'nope': truthy, so a typo in a rule granted.
  test('an undeclared name is refused, not returned as its own name', async () => {
    const r = await Eval({ code: 'return nope', fuel: FUEL })
    expect(r.error?.message ?? '').toMatch(/not defined/)
    expect(r.result).toBeUndefined()
  })

  // 0.14.0 (#4091): the clock and the random source are capabilities. Eval
  // grants both by default; a host that wants a rule to give the same answer
  // every time withholds them.
  test('a rule can be denied the clock and the random source', async () => {
    const clock = await Eval({ code: 'return Date.now() > 0', fuel: FUEL, capabilities: { clock: undefined } })
    const random = await Eval({ code: 'return Math.random() < 2', fuel: FUEL, capabilities: { random: undefined } })
    expect(clock.error?.message ?? '').toMatch(/clock/)
    expect(random.error?.message ?? '').toMatch(/random/)
  })

  // 0.14.0 (#4099): no route puts an own `__proto__` key into a result.
  test('an own __proto__ key never reaches the result', async () => {
    const r = await Eval({ code: `return JSON.parse('{"__proto__": {"admin": true}}')`, fuel: FUEL })
    expect(r.error?.message ?? '').toMatch(/__proto__/)
  })

  // On every version: a failed run's `result` is an error OBJECT, which is
  // truthy. A host checks `r.error` first, and treats only `true` as a yes (§7).
  test('a failed run puts a truthy error object in result: check r.error', async () => {
    const r = await Eval({ code: 'let i = 0\nwhile (true) { i = i + 1 }\nreturn i', fuel: 500 })
    expect(r.error).toBeDefined()
    expect(Boolean(r.result)).toBe(true) // the hazard
    expect(r.result === true).toBe(false) // why §7's rule is safe
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

// ── 6. REGRESSION CASES — fixed in 0.14.0 ───────────────────────────────
//
// Both were tripwires, asserting the defect, until 0.14.0 fixed them.
//
// Found 2026-09-11 while verifying the #52 fix: `return published`, where
// `published` is a context binding rather than a property access, yielded the
// STRING 'published', which is truthy, so a rule written that way failed open.
describe('regression: a bare context binding returns its value (fixed 0.14.0)', () => {
  test('return <binding> yields the value, not the identifier', async () => {
    const r = await Eval({
      code: 'return published',
      context: { published: false },
      fuel: FUEL,
    })
    expect(r.error).toBeUndefined()
    expect(r.result).toBe(false)
  })

  test('the property-access form is correct too', async () => {
    const r = await Eval({
      code: 'return doc.published',
      context: { doc: { published: false } },
      fuel: FUEL,
    })
    expect(r.result).toBe(false)
  })
})

// Found 2026-10-01 while assessing ajs for render-on-store (tjs-lang#59):
// compound assignment stored only the right-hand side, and reassigning an outer
// `let` inside for…of was lost. Accumulating code (renderers, counters) needed
// workarounds until 0.14.0.
describe('regression: compound assignment and for…of reassignment (tjs-lang#59, fixed 0.14.0)', () => {
  const run = async (code: string) => (await Eval({ code, fuel: FUEL })).result
  test('`+=` adds', async () => {
    expect(await run(`let s = 'a'; s += 'b'; return s`)).toBe('ab')
  })
  test('`-=` subtracts', async () => {
    expect(await run(`let n = 5; n -= 2; return n`)).toBe(3)
  })
  test('reassigning an outer let inside for…of keeps the value', async () => {
    expect(await run(`let s = ''; for (const w of ['a','b']) { s = s + w } return s`)).toBe('ab')
  })
  test('the old workarounds still work', async () => {
    expect(await run(`let s = ''; let i = 0; while (i < 2) { s = s + 'x'; i = i + 1 } return s`)).toBe('xx')
    expect(await run(`const out = []; for (const w of ['a','b']) { out.push(w) } return out.join('')`)).toBe('ab')
  })
})

// ── 7. The invariant our host must enforce regardless ───────────────────────
// UNIVERSAL-ENDPOINT.md §4.2: "non-boolean return evaluates as false". Upstream
// coerces with `!!`; we must not. Belt-and-braces now that #52 and §6 are
// fixed, and still needed: a failed run's result is a truthy error object (§2).
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
