/**
 * Pure helpers extracted from `blog.ts` (review finding F11).
 *
 * `blog.ts` registers web components at module scope, so importing it requires a
 * DOM and none of its logic could be unit-tested — in the same diff that added
 * 452 lines of backend pipeline tests. The data-loss blocker (B1) shipped from
 * that file, and `inferResolutions` decides which side of every proofreading hunk
 * won, i.e. whether the author's prose or the model's replaces it. That is worth
 * testing.
 *
 * Nothing here touches the DOM, tosijs, or the network: given the same inputs it
 * returns the same outputs. Keeping it separable also serves ROADMAP Phase 2,
 * which extracts the blog into `tosijs-blog`.
 */
import { diffLines, diffBlocks } from 'tosijs-ui/diff'

// A post's `date` can arrive as a boxed proxy scalar (an object — truthy even
// when the underlying string is empty) or a raw string. Coerce to a primitive,
// then only format a genuinely valid date; anything else is "Not Published"
// (never "Invalid Date").
export function formatBlogDate(value: unknown): string {
  const s = String(value ?? '').trim()
  if (!s) return 'Not Published'
  const t = new Date(s)
  return isNaN(t.valueOf()) ? 'Not Published' : t.toLocaleDateString()
}

// Turn a title (or a typed slug) into a URL-safe slug, matching existing posts.
export function slugify(text: string): string {
  return (
    String(text ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics
      .replace(/[^a-z0-9]+/g, '-') // non-alphanumeric → hyphen
      .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
      .slice(0, 80) || 'untitled'
  )
}

// ── Proofreader margin notes ─────────────────────────────────────────────────
// After a proofread diff resolves, each edit that LANDED (diffing the pre-proofread
// text against the result) becomes a margin annotation over that line in the editor.
// Rendered as a DOM overlay via the EditorView's own geometry (see
// `addLineAnnotation`) rather than a CodeMirror gutter: a gutter would require
// importing @codemirror/{view,state} into THIS app, loading a SECOND @codemirror
// instance alongside tosijs-ui's editor copy and breaking editor creation
// ("Unrecognized extension value… multiple instances of @codemirror/state", because
// facets/StateFields are identity-keyed). The overlay imports nothing from
// @codemirror, so it sidesteps that entirely. (tosijs-ui#131 tracks making
// @codemirror a peer dependency, which would also unblock the gutter route.)

export interface ProofNote {
  fromLine: number // 0-based line in the resolved text
  removed: string
  added: string
  accepted: boolean
}

// Walk the diff of original→revised under the reviewer's resolutions
// ('original' = rejected, 'modified' = accepted) and locate each change in the
// FINAL (resolved) text so it can be pinned to a margin-annotation line.
export function computeProofNotes(
  original: string,
  revised: string,
  resolutions: Array<'original' | 'modified'>
): ProofNote[] {
  const blocks = diffBlocks(diffLines(original, revised))
  const notes: ProofNote[] = []
  let line = 0 // 0-based line in the resolved text
  let changeIdx = 0
  for (const block of blocks) {
    if (block.kind === 'context') {
      line += block.lines.length
    } else {
      const choice = resolutions[changeIdx++] ?? 'modified'
      const kept = choice === 'modified' ? block.added : block.removed
      notes.push({
        fromLine: line,
        removed: block.removed.join('\n'),
        added: block.added.join('\n'),
        accepted: choice === 'modified',
      })
      line += kept.length
    }
  }
  return notes
}

// The native diff overlay doesn't expose the reviewer's per-hunk choices, so infer
// them: `resolved` is exactly the concatenation of each hunk's chosen side with the
// shared context, so walk the before→revised blocks against `resolved` line-by-line
// and record which side won ('modified' = accepted the suggestion, 'original' =
// kept theirs). Defaults to 'modified' when a hunk is ambiguous (both sides match)
// or unmatched — the overlay's own default for untouched hunks.
export function inferResolutions(
  before: string,
  revised: string,
  resolved: string
): Array<'original' | 'modified'> {
  const blocks = diffBlocks(diffLines(before, revised))
  const out: Array<'original' | 'modified'> = []
  const lines = resolved.split('\n')
  let i = 0
  const fits = (arr: string[]) =>
    arr.length > 0 &&
    i + arr.length <= lines.length &&
    arr.every((l, k) => lines[i + k] === l)
  for (const block of blocks) {
    if (block.kind === 'context') {
      i += block.lines.length
      continue
    }
    const addFits = fits(block.added)
    const remFits = fits(block.removed)
    if (addFits && !remFits) {
      out.push('modified')
      i += block.added.length
    } else if (remFits && !addFits) {
      out.push('original')
      i += block.removed.length
    } else if (block.added.length === 0) {
      // pure deletion suggestion: rejecting it keeps the removed lines
      if (remFits) {
        out.push('original')
        i += block.removed.length
      } else {
        out.push('modified')
      }
    } else if (block.removed.length === 0) {
      // pure insertion suggestion: accepting it inserts the added lines
      if (addFits) {
        out.push('modified')
        i += block.added.length
      } else {
        out.push('original')
      }
    } else {
      out.push('modified')
      i += block.added.length
    }
  }
  return out
}
