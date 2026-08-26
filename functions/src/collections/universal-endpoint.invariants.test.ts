// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test } from 'bun:test'

/**
 * Universal-endpoint acceptance invariants — §9 of UNIVERSAL-ENDPOINT.md.
 *
 * "Invariants (for the implementer; each should be a test)." This file is the
 * executable form of that list. Every invariant is a `test.todo` today: the
 * beforeWrite / isWriteAllowed / procedures machinery does not exist yet (see
 * UNIVERSAL-ENDPOINT-GAP-ANALYSIS.md — most rows are "New" or "Replace"), so
 * these are the Phase-1 acceptance criteria, not passing tests.
 *
 * As the pieces land, convert each `test.todo(name)` to `test(name, () => …)`.
 * Where an invariant *preserves* current behavior, the existing oracle already
 * pins the starting point — reuse it:
 *   - validate/schema legs ............ collections/validate.test.ts
 *   - dispatch / field-strain ......... collections/access.test.ts
 *   - write path E2E (emulator) ....... collections/write-path.integration.test.ts
 *
 * Determinism note: because ajs is caps-only and clock-injected (§4.1), these
 * become pure unit tests — feed (body, existing, principal, cap-responses),
 * assert the tagged result. No emulator required for §9.1–9.10.
 */

describe('§9 universal-endpoint invariants (Phase-1 acceptance)', () => {
  // ── Trust boundary (§2) ────────────────────────────────────────────────
  describe('trust boundary', () => {
    // 1. A procedure cannot acquire any capability the caller does not hold.
    //    Build a principal with cap set C; run a procedure that reaches for a
    //    cap ∉ C; assert the VM denies it (no amplification). Vary C.
    test.todo('9.1 procedure cannot exceed the caller’s capability set')

    // 2. isWriteAllowed cannot write — attempting to obtain a write capability
    //    inside a rule is a VM error, NOT a runtime convention check. Assert the
    //    evaluator handed to isWriteAllowed has no write cap and that requesting
    //    one throws at the VM boundary.
    test.todo('9.2 isWriteAllowed has no write capability (VM-enforced)')

    // 3. isWriteAllowed returns a boolean; anything else (object, string,
    //    thrown error, non-bool) evaluates to false.
    test.todo('9.3 isWriteAllowed: non-boolean return → false')

    // 10. Rule installation requires a capability that procedures and transforms
    //     can never hold. Assert a procedure/beforeWrite cannot install or modify
    //     an isWriteAllowed rule.
    test.todo('9.10 installing rules needs a capability procs/transforms can’t hold')
  })

  // ── Write pipeline (§3, §4) ────────────────────────────────────────────
  describe('write pipeline', () => {
    // 4. isWriteAllowed is invoked once per transaction with every touched
    //    document's before/after state (NOT per-document in a loop). Assert a
    //    2-doc write calls the rule once, with both before/after pairs, so a
    //    cross-doc invariant (debit==credit) is expressible.
    test.todo('9.4 isWriteAllowed invoked once per transaction with full write set')

    // 5. beforeWrite runs before isWriteAllowed on EVERY write path, including
    //    procedure-originated writes (procedures get no shortcut, §3). Assert a
    //    procedure write is transformed by beforeWrite and then gated.
    test.todo('9.5 beforeWrite precedes isWriteAllowed on all write paths (incl. procedures)')

    // 6. beforeWrite cannot read or write any document other than the one
    //    proposed, and cannot see envelope fields. Assert its injected caps
    //    expose neither a privileged read nor the envelope.
    test.todo('9.6 beforeWrite is body-only: no other docs, no envelope')

    // 7. beforeWrite is idempotent over schema-valid input (§6.1 generated
    //    test): for schema-valid x, beforeWrite(beforeWrite(x)) == beforeWrite(x).
    //    Drive from the schema's value generator.
    test.todo('9.7 beforeWrite is idempotent (generated over schema-valid input)')

    // 8. A write whose NORMALIZED body equals the stored body is a no-op: no
    //    commit, no stamp. Requires the canonical normalization (Decision #… in
    //    the gap analysis). Assert re-submitting a stored record stamps nothing.
    test.todo('9.8 body-equal write is a no-op (no commit, no new stamp)')

    // 9. Envelope fields (savedAt, version, author, createdAt, seq) are written
    //    ONLY by the endpoint at commit — never by caller/beforeWrite/procedure.
    //    Precursor behavior today: doc.ts stamps _created/_modified server-side
    //    (write-path.integration.test.ts). Port that to the envelope and assert
    //    a caller-supplied envelope field is ignored/overwritten.
    test.todo('9.9 envelope fields are server-written at commit only')
  })

  // ── Observability (§4.3, §7) ───────────────────────────────────────────
  describe('observability', () => {
    // 11. Every procedure invocation is logged with procedure name AND version
    //     (so legacy versions are visible and retired deliberately, §4.3).
    test.todo('9.11 every procedure invocation logged with name + version')

    // 12. Every query is logged with shape and cost (slowness discovered from
    //     logs, not a bill, §7).
    test.todo('9.12 every query logged with shape + cost')
  })
})
