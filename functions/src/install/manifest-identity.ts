/**
 * Is this the same published manifest version? (#5)
 *
 * Pure, and separate from the endpoint, because it decides whether an approval
 * is allowed to take effect.
 *
 * Manifests are append-only, so a version already on file is never rewritten.
 * But RE-SUBMITTING one is normal: approving a parked upgrade means POSTing the
 * same manifest again with `approving` set. So the rule cannot be "send a
 * version once" — it is "a version always means the same thing".
 *
 * The case this exists for: a library is reviewed at 1.2.0, parked pending
 * approval, and 1.2.0's collections or access rules are swapped before the
 * human clicks approve — so what takes effect is not what was read.
 * `approving` pins the capabilities; this pins everything else.
 */

/** Provenance the endpoint adds; not part of what the author published. */
const PROVENANCE = ['installedBy', 'installedAt']

/**
 * Key-order-independent serialisation.
 *
 * Keys are sorted because a manifest read back from Firestore arrives in
 * whatever order Firestore likes, and an order-sensitive comparison would
 * refuse every legitimate approval. ARRAYS keep their order, because array
 * order is meaningful here — `required: ['a','b']` and an access list are
 * sequences, not sets.
 *
 * `undefined` is dropped so that "sent as undefined" and "absent" compare
 * equal: Firestore never stores undefined, so they are the same thing on the
 * way back. `null` is a real stored value and is preserved.
 */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .filter((k) => object[k] !== undefined && !PROVENANCE.includes(k))
    .map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`)
    .join(',')}}`
}

export const sameManifest = (a: unknown, b: unknown): boolean =>
  canonical(a) === canonical(b)

/** A version was re-submitted with DIFFERENT content. Maps to 409. */
export class ManifestConflict extends Error {}
