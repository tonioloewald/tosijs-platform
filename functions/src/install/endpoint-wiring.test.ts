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

/** Remove block and line comments. Crude, and sufficient for this source. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const src = (f: string) =>
  stripComments(readFileSync(join(__dirname, '..', f), 'utf-8'))

const endpointTs = src('install/endpoint.ts')
const claimTs = src('claim.ts')
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
    expect(claimTs).toContain('decideClaim')
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

describe('the commit is one batch, epoch included', () => {
  const commitFn = endpointTs.slice(
    endpointTs.indexOf('async function commit'),
    endpointTs.indexOf('export const install')
  )

  test('it exists and is a batch', () => {
    expect(commitFn).toContain('db().batch()')
    expect(commitFn).toContain('batch.commit()')
  })

  test('the epoch bump is IN the batch, not after it', () => {
    // A bump issued after a successful commit can be lost — and then the config
    // changed while every other warm instance keeps enforcing the old rules
    // indefinitely. That is the revocation-does-not-propagate failure.
    expect(commitFn).toContain('bumpEpochIn(batch)')
    expect(commitFn).not.toMatch(/await\s+bumpEpoch\(\)/)
  })

  test('the manifest is created, never set — history is append-only', () => {
    // `set` would let a re-POST of an existing version rewrite the manifest the
    // NEXT upgrade's additive-only check diffs against.
    expect(commitFn).toMatch(/batch\.create\(ref,/)
    expect(commitFn).not.toMatch(/batch\.set\(\s*db\(\)\.collection\(MANIFESTS\)/)
    expect(commitFn).not.toMatch(/ref\.set\(/)
  })

  test('re-submitting a version is checked for CONTENT, not just existence', () => {
    // Approving a parked upgrade re-POSTs the same version, so "already on
    // file" cannot simply fail — but it must not be waved through either, or a
    // reviewed 1.2.0 can be swapped before the human clicks approve.
    expect(commitFn).toMatch(/sameManifest\(existing\.data\(\)/)
    expect(commitFn).toMatch(/throw new ManifestConflict/)
    expect(endpointTs).toMatch(/fail\(response, 409, 'conflict'/)
  })

  test('a null manifest record is guarded, not committed', () => {
    expect(commitFn).toMatch(/if \(records\.manifest\)/)
  })
})

describe('/claim runs the whole ceremony in one transaction', () => {
  test('the POST path is transactional', () => {
    expect(claimTs).toMatch(/runTransaction\(async \(tx\)/)
  })

  test('rotation is a transaction WRITE, in the same transaction', () => {
    // If rotation were a separate write, a crash between grant and rotation
    // leaves a live proof in the datastore: the next authenticated caller
    // claims for free.
    expect(claimTs).toMatch(/tx\.set\(\s*claimRef\(\),\s*rotatedState\(/)
  })

  test('the role grant is a transaction write too', () => {
    expect(claimTs).toMatch(/tx\.update\(roleDoc\.ref/)
    expect(claimTs).toMatch(/tx\.set\(admin\s*\.firestore\(\)\s*\.collection\('role'\)/)
  })

  test('it grants configurator specifically', () => {
    expect(claimTs).toContain('ROLES.configurator')
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
    expect(claimTs).toMatch(/logger\.warn\([\s\S]{0,120}outcome\.reason/)
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
    expect(indexTs).toMatch(/export \{ claim \} from '\.\/claim'/)
    expect(indexTs).toMatch(/export \{ install \} from '\.\/install\/endpoint'/)
  })
})
