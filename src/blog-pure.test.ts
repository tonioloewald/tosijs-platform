/**
 * Tests for the pure blog helpers (review finding F11).
 *
 * `src/` had no tests at all — in the same diff that added 452 lines of backend
 * pipeline tests — and the data-loss blocker (B1) shipped from `blog.ts`.
 *
 * `inferResolutions` is the one that matters most: it decides, for every hunk of
 * a proofread, whether the AUTHOR'S prose or the MODEL'S replacement is recorded
 * as having won. Getting it wrong mis-attributes someone's writing.
 *
 * Run: bun test src/blog-pure.test.ts
 */
import { describe, test, expect } from 'bun:test'
import {
  formatBlogDate,
  slugify,
  resolvePostPath,
  computeProofNotes,
  inferResolutions,
} from './blog-pure'

describe('formatBlogDate', () => {
  test('an empty or missing date is "Not Published", never "Invalid Date"', () => {
    for (const v of ['', '   ', null, undefined]) {
      expect(formatBlogDate(v)).toBe('Not Published')
    }
  })

  test('garbage is "Not Published" rather than "Invalid Date"', () => {
    expect(formatBlogDate('not a date')).toBe('Not Published')
  })

  test('a boxed proxy scalar coerces before formatting', () => {
    // The original bug: a live tosijs proxy scalar is a truthy OBJECT, so
    // `date ? format(date) : 'Not Published'` took the wrong branch and rendered
    // "Invalid Date". String() must be applied first.
    const boxedEmpty = { toString: () => '', valueOf: () => '' }
    expect(formatBlogDate(boxedEmpty)).toBe('Not Published')
  })

  test('a real date formats', () => {
    expect(formatBlogDate('2020-01-02T00:00:00.000Z')).not.toBe('Not Published')
  })
})

describe('slugify', () => {
  test('lowercases and hyphenates', () => {
    expect(slugify('Hello There World')).toBe('hello-there-world')
  })

  test('strips diacritics', () => {
    expect(slugify('Café Naïve')).toBe('cafe-naive')
  })

  test('collapses runs and trims edge hyphens', () => {
    expect(slugify('  !!Hello -- World!!  ')).toBe('hello-world')
  })

  test('never returns empty — falls back to "untitled"', () => {
    for (const v of ['', '!!!', '   ']) {
      expect(slugify(v)).toBe('untitled')
    }
  })

  test('caps length so a long title cannot produce an unbounded path', () => {
    expect(slugify('x'.repeat(200)).length).toBeLessThanOrEqual(80)
  })
})

describe('inferResolutions — whose words won', () => {
  test('all-accepted reports every hunk as modified', () => {
    const before = 'one\ntwo\nthree'
    const revised = 'one\nTWO\nthree'
    expect(inferResolutions(before, revised, revised)).toEqual(['modified'])
  })

  test('all-rejected reports every hunk as original', () => {
    const before = 'one\ntwo\nthree'
    const revised = 'one\nTWO\nthree'
    expect(inferResolutions(before, revised, before)).toEqual(['original'])
  })

  test('a mixed resolution is attributed per hunk', () => {
    const before = 'a\nkeep\nb'
    const revised = 'A\nkeep\nB'
    // took the model's first change, kept their own second
    const resolved = 'A\nkeep\nb'
    expect(inferResolutions(before, revised, resolved)).toEqual([
      'modified',
      'original',
    ])
  })

  test('an unchanged document yields no decisions', () => {
    const t = 'same\ntext'
    expect(inferResolutions(t, t, t)).toEqual([])
  })

  test('a pure insertion is attributed correctly both ways', () => {
    const before = 'a\nb'
    const revised = 'a\nnew\nb'
    expect(inferResolutions(before, revised, revised)).toEqual(['modified'])
    expect(inferResolutions(before, revised, before)).toEqual(['original'])
  })

  test('a pure deletion is attributed correctly both ways', () => {
    const before = 'a\ngone\nb'
    const revised = 'a\nb'
    expect(inferResolutions(before, revised, revised)).toEqual(['modified'])
    expect(inferResolutions(before, revised, before)).toEqual(['original'])
  })

  test('DOCUMENTED AMBIGUITY: identical hunks default to "modified"', () => {
    // F11 flagged that when both sides fit at the same position the choice is
    // silent. Pinned rather than "fixed": if the two sides are byte-identical the
    // attribution is unobservable in the text, so defaulting is safe — but the
    // default must be deliberate and known, not incidental.
    const before = 'a\nsame\nb'
    const revised = 'a\nsame\nb'
    expect(inferResolutions(before, revised, before)).toEqual([])
  })

  test('never returns more decisions than there are hunks', () => {
    const before = 'a\nb\nc\nd'
    const revised = 'A\nb\nC\nd'
    const out = inferResolutions(before, revised, 'A\nb\nc\nd')
    expect(out.length).toBe(2)
    for (const r of out) expect(['original', 'modified']).toContain(r)
  })
})

describe('computeProofNotes — where the markers land', () => {
  test('one note per changed hunk, none for unchanged text', () => {
    const notes = computeProofNotes('a\nkeep\nb', 'A\nkeep\nB', [
      'modified',
      'modified',
    ])
    expect(notes.length).toBe(2)
  })

  test('accepted and rejected are distinguished', () => {
    const notes = computeProofNotes('a\nkeep\nb', 'A\nkeep\nB', [
      'modified',
      'original',
    ])
    expect(notes.map((n) => n.accepted)).toEqual([true, false])
  })

  test('notes carry both sides so a reader can revisit the decision', () => {
    const [note] = computeProofNotes('old line', 'new line', ['modified'])
    expect(note.removed).toContain('old')
    expect(note.added).toContain('new')
  })

  test('line numbers stay within the resolved document', () => {
    const before = 'a\nb\nc'
    const revised = 'A\nb\nC'
    const notes = computeProofNotes(before, revised, ['modified', 'modified'])
    for (const n of notes) {
      expect(n.fromLine).toBeGreaterThanOrEqual(0)
      expect(n.fromLine).toBeLessThan(revised.split('\n').length)
    }
  })

  test('an unchanged document produces no notes', () => {
    expect(computeProofNotes('same', 'same', [])).toEqual([])
  })
})

describe('resolvePostPath — saving never moves an existing URL (0.2.0-beta.5, M2)', () => {
  test('a legacy path is kept EXACTLY, even where slugify would change it', () => {
    for (const legacy of ['what-s-in-a-name-', 'x'.repeat(86), 'under_score', '-leading']) {
      expect(resolvePostPath(legacy, 'Any Title')).toBe(legacy)
    }
  })

  test('an unsafe typed path is slugified', () => {
    expect(resolvePostPath('Hello World!', 'x')).toBe('hello-world')
    expect(resolvePostPath('Café', 'x')).toBe('cafe')
  })

  test('an empty path is generated from the title', () => {
    expect(resolvePostPath('', 'Hello, World')).toBe('hello-world')
    expect(resolvePostPath('   ', 'Hello, World')).toBe('hello-world')
    expect(resolvePostPath(undefined, 'Hello, World')).toBe('hello-world')
  })
})

describe('slugify agrees with the server derive for new posts (D19 accepted divergence)', () => {
  // Pinned in functions/src/collections/seed-parity.isolated.ts too.
  test('same outputs', () => {
    expect(slugify('Hello, World!')).toBe('hello-world')
    expect(slugify('What’s in a name?')).toBe('what-s-in-a-name')
    expect(slugify('snake_case title')).toBe('snake-case-title')
  })
})
