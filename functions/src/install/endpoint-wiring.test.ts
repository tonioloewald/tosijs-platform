/**
 * WIRING for `/install` and `/claim` (#5).
 *
 * `apply.ts` and `claim.ts` are pure and thoroughly tested — but a decision
 * function proves nothing about whether the endpoint calls it, commits what it
 * returns, or commits it atomically. `endpoint-wiring.test.ts` exists for
 * exactly that gap on `/doc` and `/docs`; this is the same crude instrument
 * pointed at the two most privileged handlers in the system.
 *
 * Both are `onRequest` handlers bound to Firestore transactions and batches, so
 * these assert at the SOURCE level. That is a real limitation: it can catch the
 * wiring being REMOVED, which is the failure mode that has actually happened,
 * and it cannot catch the wiring being wrong in a way that still parses.
 *
 * ## Comments are stripped first, and that is not incidental
 *
 * Two wiring assertions in this repo have passed against a DOC COMMENT rather
 * than against code — the mechanism they described was in prose and the call
 * was absent. So every assertion below runs on comment-stripped source, and
 * `the stripper works` pins the stripper itself; without that test this file
 * would be free to rot back into checking that the comments still say the right
 * thing.
 *
 * Run: cd functions && bun test src/install/endpoint-wiring.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CLAIM_PATH } from './claim'
import { EPOCH_PATH } from './epoch'
import { EPOCH_DOC } from './install-store'

/** Remove block and line comments. Crude, and sufficient for this source. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const src = (f: string) =>
  stripComments(readFileSync(join(__dirname, '..', f), 'utf-8'))

const endpointTs = src('install/endpoint.ts')
const claimTs = src('claim.ts')
const ceremonyTs = src('install/claim-ceremony.ts')
const epochTs = src('install/epoch.ts')
const indexTs = src('index.ts')

describe('the stripper works', () => {
  test('prose from the headers does not survive it', () => {
    // If these ever appear, every assertion in this file is suspect.
    const raw = readFileSync(join(__dirname, '..', 'claim.ts'), 'utf-8')
    expect(raw).toContain('standing back door')
    expect(claimTs).not.toContain('standing back door')
    expect(endpointTs).not.toContain('Owner')
  })

  test('code survives it', () => {
    expect(claimTs).toContain('claimConfigurator')
    expect(ceremonyTs).toContain('decideClaim')
    expect(endpointTs).toContain('decideInstall')
  })
})

describe('/install is gated on configurator, and refuses before reading', () => {
  test('the role check names configurator and nothing else', () => {
    expect(endpointTs).toMatch(
      /userRoles\.roles\.includes\(ROLES\.configurator\)/
    )
    expect(endpointTs).toMatch(/fail\(response, 403, 'forbidden'/)
  })

  test('the gate precedes every branch', () => {
    // A gate inside the POST case would leave GET and DELETE open.
    const gate = endpointTs.indexOf('ROLES.configurator')
    const firstCase = endpointTs.indexOf("case 'GET'")
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(firstCase)
  })

  test('there is no owner escape hatch', () => {
    // D3/D14: owner's power is the datastore, not an in-system bypass. An
    // `|| roles.includes(ROLES.owner)` here would silently reinstate the second
    // root DECISIONS.md already retracted once.
    expect(endpointTs).not.toContain('ROLES.owner')
  })

  test('both decisions are actually invoked', () => {
    expect(endpointTs).toMatch(/decideInstall\(\{/)
    expect(endpointTs).toMatch(/decideRevoke\(/)
  })
})

describe('the commit is one transaction, epoch included', () => {
  // What the commit does — manifest append-only, content-checked, epoch bumped
  // in the same transaction — is tested by behaviour in install-store.test.ts.
  test('the endpoint commits through the kernel, over the Firestore store', () => {
    expect(endpointTs).toMatch(/commitInstall\(firestoreStore, records,/)
    expect(endpointTs).not.toContain('batch()')
    expect(endpointTs).not.toContain('runTransaction')
  })

  test('the kernel bumps the epoch document epoch.ts reads', () => {
    expect(`${EPOCH_PATH.collection}/${EPOCH_PATH.doc}`).toBe(EPOCH_DOC)
  })

  test('a conflicting version still answers 409', () => {
    expect(endpointTs).toMatch(/fail\(response, 409, 'conflict'/)
  })
})

describe('/claim runs the whole ceremony in one transaction', () => {
  // The transactions themselves are tested by behaviour in
  // claim-ceremony.test.ts (including the simultaneous-claim race); what is
  // left to pin here is that the endpoint is bound to them.
  test('the POST path is the transactional kernel, over the Firestore store', () => {
    expect(claimTs).toMatch(/claimConfigurator\(firestoreStore, user, ceremonyDeps\)/)
    expect(claimTs).not.toContain('runTransaction')
  })

  test('the GET path mints through the kernel too', () => {
    expect(claimTs).toMatch(/publishNonce\(firestoreStore, ceremonyDeps\)/)
  })

  test('the published location is the document the kernel uses', () => {
    expect(`${claimTs.match(/collection: '([^']+)', doc: '([^']+)'/)?.slice(1).join('/')}`).toBe(CLAIM_PATH)
  })

  test('it grants configurator specifically', () => {
    expect(ceremonyTs).toContain('ROLES.configurator')
    expect(ceremonyTs).not.toContain('ROLES.owner')
    expect(claimTs).not.toContain('ROLES.owner')
  })

  test('POST requires an authenticated caller', () => {
    expect(claimTs).toMatch(/if \(!user\)/)
    expect(claimTs).toMatch(/fail\(response, 401, 'unauthenticated'/)
  })
})

describe('/claim discloses nothing an anonymous caller should not see', () => {
  const getBranch = claimTs.slice(
    claimTs.indexOf("if (req.method === 'GET')"),
    claimTs.indexOf('const user = await getUser(req)')
  )

  test('the published payload carries no claim history', () => {
    // Whether a host has already been claimed is a scanning signal, and the
    // proof is the one field that must never be echoed back.
    expect(getBranch).not.toContain('claimedBy')
    expect(getBranch).not.toContain('claimedAt')
    expect(getBranch).not.toMatch(/state\.proof/)
  })

  test('refusals are generic on the wire', () => {
    // decideClaim distinguishes no-nonce / expired / no-proof / mismatch for
    // the log. Returning those to the client narrates the exact state of the
    // ceremony to somebody who should not be able to observe it.
    expect(claimTs).toMatch(/fail\(response, 403, 'refused', 'claim refused'\)/)
    expect(claimTs).not.toMatch(/send\(.*outcome\.reason/)
    expect(claimTs).toMatch(/log\.warn\([\s\S]{0,120}outcome\.reason/)
  })
})

describe('the epoch document is unreachable by design', () => {
  test('it lives in a `system:` namespace, so no manifest can claim it', () => {
    expect(epochTs).toContain("collection: 'system:registry'")
  })

  test('the claim state does too', () => {
    expect(claimTs).toContain("collection: 'system:claim'")
  })

  test('neither is a registered collection', () => {
    // Registering one would make it writable through /doc by whoever the config
    // granted — and an epoch an attacker can pin stops revocations propagating.
    const seed = src('collections/seed-configs.ts')
    expect(seed).not.toContain('system:')
  })
})

describe('/doc and /docs resolve through the registry', () => {
  // Installing writes records; this is what makes them mean anything. Without
  // it /install succeeds, reports success, and changes nothing observable —
  // the worst possible failure for the endpoint virta is waiting on.
  const docTs = src('doc.ts')
  const docsTs = src('docs.ts')

  test('both handlers build a per-request map', () => {
    expect(docTs.match(/collectionsFor\(_collectionPath\)/g)).toHaveLength(2)
    expect(
      docsTs.match(/collectionsFor\(collectionPath\(path\)\)/g)
    ).toHaveLength(2)
  })

  test('the access gate consults that map, not the compiled one', () => {
    for (const source of [docTs, docsTs]) {
      expect(source).toMatch(/getMethodAccess\(\s*collections,/)
      expect(source).not.toMatch(/getMethodAccess\(\s*COLLECTIONS,/)
    }
  })

  test('COLLECTIONS survives only as the default argument', () => {
    // Any remaining `COLLECTIONS[...]` lookup is a path that would deny every
    // installed collection while the rest of the handler thinks it resolved.
    expect(docTs).not.toMatch(/COLLECTIONS\[/)
    expect(docsTs).not.toMatch(/COLLECTIONS\[/)
  })

  test('the store is built per request, carrying that map', () => {
    // A module-level store resolves an installed collection's unique key
    // against the platform map — which has no entry — and rejects every
    // `field=value` path as "not an allowed key".
    expect(docTs).toMatch(/const store = storeFor\(collections\)/)
    expect(docTs).not.toMatch(/const store = new FirestoreStore/)
  })
})

describe('both endpoints are actually exported', () => {
  test('index.ts exports them, or they do not deploy at all', () => {
    expect(indexTs).toMatch(/export const claim = firebaseEndpoint\(handleClaim\)/)
    expect(indexTs).toMatch(/export const install = firebaseEndpoint\(handleInstall\)/)
  })
})

describe('the proposal flow and the cleanup are the tested ones (0.4.0 re-review R1)', () => {
  // proposal-handler.test.ts and sweep.test.ts run the flow for real. This is
  // the other half: the endpoints call THOSE functions, and do not carry a
  // private copy of the flow that the tests never see.
  const authorizeTs = src('auth/authorize-endpoint.ts')

  test('/install proposes and approves through proposal-handler', () => {
    expect(endpointTs).toMatch(/proposeManifest\(/)
    expect(endpointTs).toMatch(/approveProposal\(/)
    expect(endpointTs).toMatch(/install:\s*\(input\)\s*=>\s*runInstall\(/)
  })

  test('the endpoint has no second copy of the approval flow', () => {
    expect(endpointTs).not.toContain('approvingFrom')
    expect(endpointTs).not.toMatch(/decided\(/)
  })

  test('a denial is conditional on the proposal STILL being pending', () => {
    // Unconditional, it could overwrite a proposal an approval had just taken,
    // recording "denied" while that install ran.
    const deny = endpointTs.slice(endpointTs.indexOf('req.body?.approve === false'))
    expect(deny.slice(0, 600)).toMatch(/updateIf\(\s*requestId,\s*\(current\) => proposalState\(current, Date\.now\(\)\) === 'pending'/)
  })

  test('both anonymous request collections are swept by the shared rule', () => {
    expect(endpointTs).toMatch(/storeSweepable\(firestoreStore, PROPOSALS\)/)
    expect(authorizeTs).toMatch(/sweepExpired\(storeSweepable\(firestoreStore, AUTHORIZE_COLLECTION\)/)
  })

  test('the authority pages are sent with the no-framing headers', () => {
    for (const source of [endpointTs, claimTs, authorizeTs]) expect(source).toMatch(/response\.set\(PAGE_HEADERS\)/)
  })
})

