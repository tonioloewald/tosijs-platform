/**
 * The client uses no tosijs API that warns as deprecated, so a new warning in
 * the console is news rather than noise. A static scan; tosijs-ui's own
 * warnings (`<tosi-tabs>`'s onCloseTab) are upstream's.
 *
 * Run: bun test ./src/deprecated-tosijs.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const SRC = import.meta.dir
const sources = readdirSync(SRC)
  .filter(
    (n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && !n.endsWith('.d.ts')
  )
  .map((n) => ({ name: n, text: readFileSync(join(SRC, n), 'utf-8') }))

const DEPRECATED: Array<[RegExp, string]> = [
  // "Passing tag/styleSpec to elementCreator() is deprecated": static preferredTagName / lightStyleSpec.
  [
    /\.elementCreator\(\s*\{/,
    'elementCreator({ tag, styleSpec }): use static preferredTagName and static lightStyleSpec',
  ],
  // "<xin-slot> is deprecated and will be REMOVED IN 2.0".
  [
    /\bxinSlot\b|<xin-slot\b|'xin-slot'/,
    'xin-slot: use tosiSlot / <tosi-slot>',
  ],
  // `.xinValue` no longer typechecks (tosijs 1.7).
  [/\.xinValue\b|\bxinValue\(/, 'xinValue: use .value / tosiValue()'],
]

test('the scan reads the client sources', () => {
  expect(sources.map((s) => s.name)).toContain('blog.ts')
})

for (const [pattern, use] of DEPRECATED) {
  test(use.split(':')[0], () => {
    expect(
      sources
        .filter((s) => pattern.test(s.text))
        .map((s) => `${s.name}: ${use}`)
    ).toEqual([])
  })
}
