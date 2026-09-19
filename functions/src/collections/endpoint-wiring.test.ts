/**
 * Endpoint WIRING tests (review findings F2, F5).
 *
 * The review's sharpest observation: mutation testing showed that deleting the
 * `afterWrite` call and reverting the opaque LIST status left the suite
 * *byte-identically green*. `opacity.test.ts` and `after-write.test.ts` pin the
 * extracted helpers in isolation — `opacity.test.ts` imports only `./access`, so
 * it is structurally incapable of noticing whether any endpoint calls it.
 *
 * A helper test proves the helper works. It cannot prove the endpoint uses it.
 * This file covers the second question.
 *
 * `doc.ts` / `docs.ts` are `onRequest` handlers bound to Firestore and cannot be
 * driven without an emulator, so these assert the wiring at the SOURCE level.
 * That is crude, and deliberately so: it is the cheapest thing that actually
 * fails when the wiring is removed, which is the property the previous tests
 * lacked. Replace it with a real harness when the handlers are extracted
 * (tracked as the remainder of F2).
 *
 * Run: cd functions && bun test src/collections/endpoint-wiring.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf-8')
const docTs = src('doc.ts')
const docsTs = src('docs.ts')
// Since the 2026-09-16 cutover the write DECISION lives in the pipeline and only
// the commit and the HTTP mapping remain in doc.ts, so wiring assertions about
// rejection messages have to span both files.
const pipelineTs = src('collections/write-pipeline.ts')

describe('getUserRoles: the B1 defects stay fixed (#6)', () => {
  // Every assertion here matches a CALL FORM, never prose — two wiring tests in
  // this repo have previously passed against a doc comment describing a
  // mechanism that was not in the code.
  const utilities = src('utilities.ts')

  test('tokens are checked for revocation', () => {
    // Without the second argument a revoked or disabled session keeps full
    // access for the remaining life of an issued ID token, ~1h.
    expect(utilities).toMatch(/verifyIdToken\(idToken, true\)/)
  })

  test('the read path no longer WRITES', () => {
    // The uid writeback made `userIds` a cache wearing a grant's costume:
    // removing a uid was undone on the principal's next request, by a write
    // that happened during a read and so appeared in no audit.
    expect(utilities).not.toMatch(/\.update\(\{\s*userIds/)
    expect(utilities).not.toMatch(/userIds\.push\(/)
  })

  test('all matching role documents are joined, not [0]', () => {
    expect(utilities).toMatch(/joinRoleDocs\(docs/)
    expect(utilities).not.toMatch(/roles\[0\]/)
    expect(utilities).not.toMatch(/const firstRole/)
  })

  test('the email lookup is a query, not a scan', () => {
    expect(utilities).toMatch(/'contacts',\s*\n?\s*'array-contains'/)
    expect(utilities).not.toMatch(/allRoles\.find\(/)
  })

  test('/install attributes the act to the TOKEN, not the role document', () => {
    const installTs = src('install/endpoint.ts')
    expect(installTs).toMatch(/const uid = user\.uid/)
    expect(installTs).not.toMatch(/userRoles\.userIds\[0\]/)
  })
})

describe('docs.ts routes LIST denials through opaqueStatus', () => {
  test('it imports the shared helper', () => {
    expect(docsTs).toMatch(/opaqueStatus/)
  })

  test('the denial branch uses it rather than a bare 403', () => {
    // The exact regression: `res.status(403).send()` for a non-listable
    // collection, which confirmed the collection exists while /doc hid it.
    expect(docsTs).toContain('opaqueStatus(userRoles, 403)')
    expect(docsTs).not.toMatch(/res\.status\(403\)/)
  })
})

describe('doc.ts denial branches do not disclose existence', () => {
  test('the access-gate denial is privilege-gated, not a bare 403', () => {
    // Non-privileged callers must get 404 there.
    expect(docTs).toMatch(/hasPrivilegedRole\(userRoles\)/)
    expect(docTs).toMatch(/status\(404\)\.send\('not found'\)/)
  })

  test('the DELETE denial is opaque', () => {
    const del = docTs.slice(
      docTs.indexOf("case 'DELETE':"),
      docTs.indexOf("case 'POST':")
    )
    expect(del).toContain('opaqueStatus(userRoles, 403)')
  })

  test('no DENIAL response reflects the caller-supplied path back', () => {
    // Post-authorization 403s are fine (the caller already holds write access to
    // the collection), but echoing input is gratuitous. Scoped to 4xx/5xx — a
    // success body like `updated ${path}` is legitimate and must not trip this.
    const reflecting = [
      ...docTs.matchAll(/\.status\(\s*(4\d\d|5\d\d)\s*\)\s*\.send\(`[^`]*\$\{path\}[^`]*`\)/g),
    ].map((m) => m[0])
    expect(reflecting).toEqual([])
  })

  test('the two post-authorization conflicts say what happened without echoing input', () => {
    // The messages themselves moved into the pipeline at the cutover...
    expect(pipelineTs).toContain("message: 'document already exists'")
    expect(pipelineTs).toContain("message: 'cannot update non-existent document'")
    // ...and neither interpolates the caller's path.
    expect(pipelineTs).not.toMatch(/message: `[^`]*\$\{path\}/)
  })

  test('doc.ts maps existence rejections to 403, not the opaque 404', () => {
    // This is the half that stayed behind, and it is the one that can regress:
    // the pipeline returns a typed reason and doc.ts chooses the status. Sending
    // 404 here would be "safer" and wrong — the caller already holds write
    // access, so hiding existence only degrades an author's error messages
    // (review F5). Pinned because nothing else would notice the change.
    const write = docTs.slice(docTs.indexOf("case 'POST':"))
    expect(write).toMatch(
      /reason === 'exists' \|\| outcome\.reason === 'missing'[\s\S]{0,120}status\(403\)/
    )
  })

  test('doc.ts is wired to the pipeline and keeps no second write path', () => {
    // The cutover's real risk is a partial revert leaving both paths alive.
    expect(docTs).toContain('runWritePipeline(')
    // The inline sequence's distinctive steps must be gone from doc.ts.
    expect(docTs).not.toContain('config.validate(')
    expect(docTs).not.toContain('validateWithSchema(')
    // Shadow mode compared the pipeline against the inline path; with the inline
    // path gone it would compare the pipeline to itself and always "match",
    // which is worse than no check at all.
    expect(docTs).not.toContain('shadowCompareWrite')
  })

  test('isUnique is bound with document identity at the call site', () => {
    // A 2-arg `isUnique` that drops the document's own identity cannot exclude
    // it from its own collision check, so every update would fail its own
    // unique constraint (review F12 predicted exactly this at cutover).
    //
    // Since the substrate port (#7) the identity is the CANONICAL path rather
    // than a Firestore ref — the property is unchanged, the spelling is not.
    expect(docTs).toMatch(
      /isUnique:\s*\(field,\s*value\)\s*=>[\s\S]{0,120}store\.isUnique\([^)]*canonicalPath/
    )
  })

  test('mutations go through the Store port, not Firestore directly', () => {
    // The port's whole claim is that `/doc` talks to a Store. A stray
    // `ref.set()` / `ref.delete()` would silently bypass it — and keep working,
    // which is why this is asserted rather than assumed.
    // Match the CALL form (`await ref.set(`), not the bare words — doc comments
    // in this file still discuss `ref.set()` historically, and matching prose
    // instead of code is how a source-level test passes for the wrong reason.
    const handler = docTs.slice(docTs.indexOf("switch (req.method)"))
    expect(handler).not.toMatch(/await\s+ref\.set\(/)
    expect(handler).not.toMatch(/await\s+ref\.delete\(/)
    expect(handler).toMatch(/store\.set\(canonicalPath/)
    expect(handler).toMatch(/store\.delete\(canonicalPath/)
  })
})

describe('doc.ts fires afterWrite on every mutation path', () => {
  test('both the write and the delete branch invoke it', () => {
    const callSites = docTs.match(/config\.afterWrite\(/g) ?? []
    expect(callSites.length).toBeGreaterThanOrEqual(2)
  })

  test('each call site follows its commit, never precedes it', () => {
    // The original bug was ordering: invalidating before the write let a reader
    // repopulate the cache from pre-write data.
    const del = docTs.slice(
      docTs.indexOf("case 'DELETE':"),
      docTs.indexOf("case 'POST':")
    )
    expect(del.indexOf('ref.delete()')).toBeLessThan(del.indexOf('config.afterWrite('))

    const write = docTs.slice(docTs.indexOf("case 'POST':"))
    expect(write.indexOf('ref.set(data)')).toBeLessThan(
      write.indexOf('config.afterWrite(')
    )
  })

  test('afterWrite failures never fail the request', () => {
    // The write already succeeded; a cache-invalidation error must not turn a
    // saved document into a client-visible error.
    const warnings = docTs.match(/afterWrite failed/g) ?? []
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })
})

/**
 * `/state` must stay gone.
 *
 * It was a second, unaudited write path into the same datastore the access
 * model governs: owner-gated, but bypassing COLLECTIONS, schema, validate,
 * uniqueness and afterWrite entirely — writing arbitrary caller-named
 * collections with `merge:true`, stamping `_path` into stored documents (the one
 * field /doc deliberately strips, so it could forge the provenance §5 calls
 * unforgeable), and batch-deleting whole collections.
 *
 * Removed 2026-09-18, BEFORE the install system ships: every invariant /install
 * asserts would otherwise be bypassable with one `POST /state/push`. This is the
 * cheapest durable way to make its return a deliberate act rather than a merge.
 */
describe('/state stays retired', () => {
  test('the module is gone', () => {
    expect(existsSync(join(__dirname, '..', 'state.ts'))).toBe(false)
  })

  test('nothing exports or imports it', () => {
    const index = src('index.ts')
    expect(index).not.toMatch(/export\s*\{\s*state\s*\}/)
    expect(index).not.toMatch(/from '\.\/state'/)
  })
})

describe('capability tokens are actually wired (B2, #6)', () => {
  // Call forms only, never prose.
  const utilities = src('utilities.ts')
  const access = src('collections/access.ts')
  const endpoint = src('auth/endpoint.ts')
  const records = src('collections/token-records.ts')

  test('getUserRoles routes a token bearer to the token path', () => {
    expect(utilities).toMatch(/bearer\?\.startsWith\(TOKEN_PREFIX\)/)
    expect(utilities).toMatch(/return rolesForToken\(bearer\)/)
  })

  test('it ATTENUATES — the agent never gets the human authority', () => {
    // `roles: principal.roles` here would hand every agent its human's full
    // authority, which is the entire thing this design exists to prevent.
    expect(utilities).toMatch(/roles: authority\.roles/)
    expect(utilities).not.toMatch(/roles: principal\.roles/)
  })

  test('the principal is read LIVE, not trusted from the record', () => {
    // `record.caveats.roles` used directly would mean a token keeps working
    // after its human is revoked.
    expect(utilities).toMatch(/tokenAuthority\(record, principal\.roles/)
  })

  test('only a HASH is ever looked up, never a stored secret', () => {
    expect(utilities).toMatch(/hashToken\(secret\)/)
    expect(endpoint).toMatch(/hash: hashToken\(secret\)/)
    // The secret must never be written next to the hash.
    expect(endpoint).not.toMatch(/secret,\s*\n\s*hash:/)
    expect(endpoint).not.toMatch(/\bsecret: secret\b/)
  })

  test('caveats are enforced in getMethodAccess — the single gate', () => {
    // Per-endpoint checks would be a list that has to stay complete forever.
    expect(access).toMatch(/caveatsAllow\(userRoles\.token, method, collectionPath\)/)
    expect(access).toMatch(/return undefined/)
  })

  test('the caveat check runs BEFORE any grant is collected', () => {
    const gate = access.indexOf('caveatsAllow(')
    const grants = access.indexOf('const grants:')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(grants)
  })

  test('the token collection is reachable by nobody through /doc', () => {
    expect(records).toMatch(/access: \{\}/)
    expect(records).not.toMatch(/ROLES\./)
  })

  test('revoking tombstones — provenance outlives the credential', () => {
    expect(endpoint).toMatch(/revokedAt: new Date\(\)\.toJSON\(\)/)
    expect(endpoint).not.toMatch(/ref\.delete\(\)/)
  })

  test('a token may not mint another token, at the endpoint too', () => {
    expect(endpoint).toMatch(/viaToken/)
  })
})

describe('/authorize never hands the browser a credential (B2, #6)', () => {
  const authz = src('auth/authorize-endpoint.ts')
  const page = src('auth/consent-page.ts')
  const pure = src('auth/authorize.ts')

  test('approval records WHO and does not mint', () => {
    // Minting at approval would mean storing a secret until collection, and a
    // revocation in between would not take effect.
    const approve = authz.slice(
      authz.indexOf("if (action === 'approve')"),
      authz.indexOf("if (action === 'exchange')")
    )
    expect(approve).not.toMatch(/newTokenSecret\(/)
    expect(approve).not.toMatch(/decideMint\(/)
  })

  test('minting happens at exchange, from LIVE roles', () => {
    expect(authz).toMatch(/const principal = await rolesOf\(decision\.principalUid\)/)
    expect(authz).toMatch(/principalRoles: principal/)
  })

  test('the request is consumed in the SAME batch as the token', () => {
    // A crash between them would leave a request still exchangeable for a
    // second credential.
    expect(authz).toMatch(/batch\.update\(ref, \{ usedAt/)
    expect(authz).toMatch(/await batch\.commit\(\)/)
  })

  test('a token may not approve an authorization', () => {
    expect(authz).toMatch(/if \(!user \|\| userRoles\.token\)/)
  })

  test('the verifier is checked before status is revealed', () => {
    const exchange = pure.slice(pure.indexOf('export function decideExchange'))
    const verifierCheck = exchange.indexOf('bad-verifier')
    const statusRead = exchange.indexOf("record.status === 'pending'")
    expect(verifierCheck).toBeGreaterThan(-1)
    expect(verifierCheck).toBeLessThan(statusRead)
  })

  test('the consent page escapes everything it renders', () => {
    // The label and caveats are attacker-supplied: whoever starts a request
    // chooses them, and a human reads the result.
    expect(page).toMatch(/escape\(record\.label\)/)
    expect(page).toMatch(/replace\(\s*\n?\s*\/\[&<>"'\]\/g/)
  })

  test('poll mode carries the phishing warning on the page itself', () => {
    expect(page).toMatch(/record\.mode === 'poll'/)
    expect(page).toMatch(/Check you started this/)
  })
})
