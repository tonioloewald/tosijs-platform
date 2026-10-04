/**
 * cleanName (sandbox-lib.js) picks the name a legacy file gets in a storage
 * area. It must always produce a name /blob accepts, and must not merge two
 * real production names into one.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain JS module
import { cleanName } from './sandbox-lib.js'
import { validateBlobPath } from '../functions/src/collections/blob'

describe('cleanName', () => {
  test('the real production cases', () => {
    expect(cleanName('Character Sheet.pdf')).toBe('Character-Sheet.pdf')
    expect(cleanName("ChatGPT-is-artificial-something-but-it's-not-even-stupid.webp")).toBe(
      'ChatGPT-is-artificial-something-but-it-s-not-even-stupid.webp'
    )
    expect(cleanName('caveman-with-VR-headset,-stalked-by-monster.webp')).toBe('caveman-with-VR-headset-stalked-by-monster.webp')
    expect(cleanName('BabylonJS Node Material Editor')).toBe('BabylonJS-Node-Material-Editor')
  })
  test('a name that is already fine is unchanged', () => {
    for (const n of ['Harris-2024.jpeg', 'Resolution_Table_v2.pdf', 'Nikon-zf', 'a.b.c']) expect(cleanName(n)).toBe(n)
  })
  test('whatever goes in, /blob accepts what comes out', () => {
    for (const n of [' leading space.png', '.hidden', '--x--', 'ünïcödé name.png', 'a/b', '***', '', 'trailing. ', "it's (1).png"]) {
      expect(validateBlobPath(cleanName(n))).toBeNull()
    }
  })
})
