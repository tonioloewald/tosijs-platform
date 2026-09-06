# Upstream dependencies — filed issues and local workarounds

Things this repo works around that belong to another repo. **File, don't fix**: we never edit the
upstream repo from here. Each entry records the issue URL, what we do locally until it lands, and
what to delete when it does.

Created 2026-09-06 from `reviews/2026-09-06-backend-consolidation.md` (U1–U3).

---

## U1 — `tosijs-ui`: `@codemirror/*` should be a peer dependency

**Issue:** https://github.com/tonioloewald/tosijs-ui/issues/131

`<tosi-code>` exposes the raw CodeMirror `EditorView` (`.editor`) and the 1.7 changelog invites
consumers to extend it, but `@codemirror/*` ship as regular `dependencies`. CodeMirror keys facets
and `StateField`s by object identity, so a consumer importing `@codemirror/view` to add a gutter can
end up with a second instance — which fails *silently* (the extension is dropped) or fatally
(`Unrecognized extension value… multiple instances of @codemirror/state`, killing editor creation).

**Local workaround — do not remove without checking #131:**
`src/blog.ts` renders proofreading margin notes as a **DOM overlay** positioned via the live
`EditorView`'s own `coordsAtPos()`, importing nothing from `@codemirror`. `CmView` is typed as
`NonNullable<CodeEditor['editor']>` so even the *type* import is avoided.

**The rule this implies:** nothing under `src/` may import `@codemirror/*`. That currently lives
only as prose in the one file that already obeys it. TODO F25 tracks adding a
`no-restricted-imports` lint rule and dropping the unused `@codemirror/lint` dep.

**When #131 lands:** the gutter approach becomes available again (it is the better rendering), and
the overlay in `blog.ts` can be reconsidered — though the decoupled version may still be preferable.

---

## U2 — `tjs-lang`: a corrupted rule result coerces to a GRANT

**Issue:** https://github.com/tonioloewald/tjs-lang/issues/54
**Related:** https://github.com/tonioloewald/tjs-lang/issues/52 (the underlying dot-path defect)

tjs-lang#52 records that returning a context dot-path yields the path *string* rather than the
value (`return doc.published` → `'doc.published'`), with no error. The escalation found by the
2026-09-06 review is what that does inside the reference RBAC layer: `rules.tjs` ends with
`allowed: !!result`, so a rule corrupted by #52 returns a non-empty string → **truthy → access
granted**. A security rule that fails *open* under a known language defect.

**Ask upstream:** a non-boolean rule result must deny (or throw), never coerce. That is the
fail-closed default the surrounding design already assumes.

**Local status:** no live exposure — no ajs-backed endpoint is exported yet. But this **invalidates
a claim we shipped**: `tjs-lang.baseline.test.ts`, `ROADMAP.md` and `write-pipeline.ts` all state
that pure boolean predicates are "unaffected" by #52, and that claim is cited as the basis for the
Phase 0 decision to keep rules as predicates. The decision still stands (transforms are worse), but
the reasoning must be corrected. Tracked as TODO F3.

---

## U3 — `tosijs-ui`: `<tosi-diff>`'s custom properties are undeclared API

**Issue:** https://github.com/tonioloewald/tosijs-ui/issues/143

`src/style.ts` pins `--tosi-diff-bg` / `--tosi-diff-color` to make the diff readable inside
`<tosi-code>`'s shadow root, where `--text-color` is the light code colour and the diff's own
fallback background is `#fff` (near-white on white). Those custom properties are set on a component
nested inside another component's shadow tree, held only by the `^1.12.8` range.

**Risk:** a patch release renaming those properties, or reshaping that tree, breaks the proofreading
UI in production with no build error and no test signal.

**Ask upstream:** declare the `--tosi-diff-*` custom properties as public API (documented and
covered), or tell us the supported way to theme a diff rendered inside `<tosi-code>`.

**Local workaround until then:** consider pinning `tosijs-ui` exactly rather than with a caret.
