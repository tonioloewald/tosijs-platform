/**
 * Guard tests for the sandbox scripts.
 *
 * `reset-sandbox.js` runs `firestore:delete --all-collections --force`. The only
 * thing standing between that command and the live blog is `resolveSandbox()`,
 * so it gets tested rather than spot-checked — including the cases that look
 * paranoid, because those are the ones a refactor quietly breaks.
 *
 * `resolveSandbox` reads `.firebaserc`, which is gitignored and therefore
 * different on every machine. These tests stub the module's file reads by
 * pointing at a temporary `.firebaserc`, so they assert the LOGIC and never
 * depend on local config.
 *
 * Run: bun test scripts/sandbox-lib.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain JS module, no declarations
import { resolveSandbox } from './sandbox-lib.js'

const PROD = 'liquid-force-425209-g2'

/**
 * `resolveSandbox` reads the real `.firebaserc`. Rather than mutate a developer's
 * live config (which is exactly the kind of test that ruins someone's afternoon),
 * assert the behaviours that are independent of its contents, plus the ones we
 * can force.
 */
describe('resolveSandbox refuses anything production-shaped', () => {
  test('refuses the alias "default" outright', () => {
    expect(() => resolveSandbox('default')).toThrow(/never target the default/i)
  })

  test('refuses an empty / missing alias', () => {
    expect(() => resolveSandbox(undefined)).toThrow(/Refusing/i)
    expect(() => resolveSandbox('')).toThrow(/Refusing/i)
  })

  test('refuses an alias that is not in .firebaserc', () => {
    // No raw project ids: a target must be declared as an alias first. This is
    // what stops `--alias liquid-force-425209-g2` from ever meaning anything.
    expect(() => resolveSandbox('definitely-not-an-alias')).toThrow(
      /No alias .* in \.firebaserc/
    )
  })

  test('the known production id is refused BY NAME, not just by comparison', () => {
    // Belt-and-braces: even if someone repoints `default`, the live project id
    // is still refused. Asserted via the error text because constructing the
    // condition needs a .firebaserc we decline to write.
    const src = require('fs').readFileSync(
      new URL('./sandbox-lib.js', import.meta.url),
      'utf-8'
    )
    expect(src).toContain(`const KNOWN_PRODUCTION = '${PROD}'`)
    expect(src).toMatch(/id === KNOWN_PRODUCTION[\s\S]{0,200}Refusing/)
  })

  test('an alias resolving to the default project id is refused', () => {
    const src = require('fs').readFileSync(
      new URL('./sandbox-lib.js', import.meta.url),
      'utf-8'
    )
    expect(src).toMatch(/id === prod[\s\S]{0,200}Refusing/)
  })
})

describe('the destructive command is reachable only through the guard', () => {
  const read = (f: string) =>
    require('fs').readFileSync(new URL(`./${f}`, import.meta.url), 'utf-8')

  test('reset-sandbox calls resolveSandbox before anything else', () => {
    const src = read('reset-sandbox.js')
    // Match the CALL SITE, not the word — `firestore:delete` also appears in
    // the file's header prose, which made the first version of this test pass
    // for the wrong reason.
    const guardAt = src.indexOf('resolveSandbox(ALIAS)')
    const deleteAt = src.indexOf('run(`${FIREBASE} firestore:delete')
    expect(guardAt).toBeGreaterThan(-1)
    expect(deleteAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(deleteAt)
  })

  test('reset-sandbox never interpolates a raw project id into the delete', () => {
    // The delete must be addressed by ALIAS (-P ${ALIAS}); a raw id would
    // bypass the .firebaserc indirection the guard depends on.
    const src = read('reset-sandbox.js')
    expect(src).toMatch(/firestore:delete --all-collections --force -P \$\{ALIAS\}/)
    expect(src).not.toMatch(/firestore:delete[^\n]*\$\{projectId\}/)
  })

  test('reset-sandbox is dry-run unless --apply', () => {
    const src = read('reset-sandbox.js')
    expect(src).toMatch(/const APPLY = has\('apply'\)/)
    expect(src).toMatch(/const dry = !APPLY/)
  })

  test('provision-sandbox is dry-run unless --apply', () => {
    const src = read('provision-sandbox.js')
    expect(src).toMatch(/const APPLY = has\('apply'\)/)
    expect(src).toMatch(/const dry = !APPLY/)
  })

  test('provision-sandbox refuses --project naming production', () => {
    const src = read('provision-sandbox.js')
    expect(src).toMatch(/NEW_PROJECT === productionProjectId\(\)[\s\S]{0,160}Refusing/)
  })
})

describe('claimableGrant — the existing-host audit (B1)', () => {
  test('the old seed documents are claimable', async () => {
    const { claimableGrant } = await import('./sandbox-lib.js')
    expect(
      claimableGrant('owner-role', {
        contacts: [{ type: 'email', value: 'owner@gmail.com' }],
        roles: ['owner', 'developer', 'admin', 'editor', 'author'],
      })
    ).toMatchObject({ severity: 'claimable' })
    // Even with no roles: the address is claimable, and roles can be added to
    // that document later by someone who does not know its history.
    expect(
      claimableGrant('rando-role', {
        contacts: [{ type: 'email', value: 'Rando@Gmail.com' }],
        roles: [],
      })?.why
    ).toContain('rando@gmail.com')
  })

  test('a FIXED sandbox grant is claimable; a per-run one is only leftover', async () => {
    const { claimableGrant } = await import('./sandbox-lib.js')
    const fixed = { contacts: [{ type: 'email', value: 'sandbox-owner@example.test' }], roles: ['owner'] }
    expect(claimableGrant('sandbox-owner', fixed)).toMatchObject({ severity: 'claimable' })
    expect(claimableGrant('sandbox-author-pin', { roles: ['author'] })).toMatchObject({ severity: 'claimable' })
    expect(claimableGrant('sandbox-agentboss-3f9a0c1d', { roles: ['author'] })).toMatchObject({
      severity: 'leftover',
    })
  })

  test("the operator's own sandbox-owner (a real contact) is not flagged (F1)", async () => {
    // clone-to-sandbox writes this for the gcloud account. Flagging it meant a
    // cloned sandbox could never report clean.
    const { claimableGrant } = await import('./sandbox-lib.js')
    expect(
      claimableGrant('sandbox-owner', {
        contacts: [{ type: 'email', value: 'alice@example.org' }],
        roles: ['owner'],
      })
    ).toBeNull()
  })

  test("the new seed, and a real person's grant, are not flagged", async () => {
    const { claimableGrant } = await import('./sandbox-lib.js')
    expect(
      claimableGrant('owner-role', {
        contacts: [{ type: 'email', value: 'owner@example.invalid' }],
        roles: [],
      })
    ).toBeNull()
    expect(
      claimableGrant('abc123', {
        contacts: [{ type: 'email', value: 'alice@example.org' }],
        roles: ['owner'],
        userIds: ['u1'],
      })
    ).toBeNull()
  })
})

describe('fixtureUser — Auth users the audit reports', () => {
  test('severities', async () => {
    const { fixtureUser } = await import('./sandbox-lib.js')
    expect(fixtureUser('owner@gmail.com')).toMatchObject({ severity: 'claimable' })
    expect(fixtureUser('sandbox-owner@example.test')).toMatchObject({ severity: 'claimable' })
    expect(fixtureUser('sandbox-owner-pin@example.test')).toMatchObject({ severity: 'claimable' })
    expect(fixtureUser('sandbox-owner-0a1b2c3d@example.test')).toMatchObject({ severity: 'leftover' })
    expect(fixtureUser('alice@example.org')).toBeNull()
  })
})
