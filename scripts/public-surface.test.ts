/**
 * The npm package's RUNTIME surface, pinned (0.2.0 review).
 *
 * `lib/index.ts` is the whole contract a consumer imports. 0.2.x promises these
 * names are stable, so adding, removing or renaming one must be a deliberate
 * edit here — not something a refactor does silently. (Type-only exports are
 * checked by the compiler and by release-doctor's packaged-exports check.)
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import * as pkg from '../lib/index'

describe('service-compris public surface (0.2.x)', () => {
  test('the runtime exports are exactly these', () => {
    expect(Object.keys(pkg).sort()).toEqual([
      'ALL',
      'ENVELOPE_FIELDS',
      'PRIVILEGED_ROLES',
      'ROLES',
      'STAMPED_FIELDS',
      'accessMap',
      'anonymousUser',
      'collectionPath',
      'getMethodAccess',
      'hasPrivilegedRole',
      'isUnchanged',
      'opaqueStatus',
      'runWritePipeline',
      'setAccessLogger',
      'stripEnvelope',
    ])
  })

  test('setAccessLogger receives the fail-closed refusal for an unenforceable write restriction', () => {
    // A restricted WRITE (a field map) cannot be honoured by the write path,
    // so it must be refused AND reported — silently refused looks like a bug.
    const seen: string[] = []
    pkg.setAccessLogger({
      warn: (...a: unknown[]) => seen.push(a.map(String).join(' ')),
      error: (...a: unknown[]) => seen.push(a.map(String).join(' ')),
      info: () => undefined,
    } as never)
    try {
      const decision = pkg.getMethodAccess(
        { thing: { access: { [pkg.ROLES.author]: { write: { title: true } as never } } } },
        'thing',
        'PUT',
        { name: 'a', contacts: [], roles: [pkg.ROLES.author], userIds: ['u'] }
      )
      expect(decision).toBeUndefined()
      expect(seen.length).toBeGreaterThan(0)
    } finally {
      pkg.setAccessLogger(console as never)
    }
  })
})
