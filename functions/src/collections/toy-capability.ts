/**
 * The Marvelous Toy — the minimal capability fixture for the universal endpoint
 * (see UNIVERSAL-ENDPOINT.md §2.6). Its whole job is to be a capability whose
 * effect is tiered by the caller's rights, so the §9 gate invariants have
 * something trivial to test against before any real capability (or the VM
 * injection) exists.
 *
 * Behaviour tiers by principal:
 *   - unauthenticated (no principal) → DENIED — you can't use it at all.
 *   - authenticated, no `admin` role  → INERT — it "doesn't do anything".
 *   - `admin`                         → ACTIVE — it makes a silly noise.
 *
 * This is a PURE reference model (roles in → outcome out); the real toy will be
 * an injected op that reads the same principal. Flavour nod to Tom Paxton's song
 * "The Marvelous Toy" — a toy that made delightful nonsense sounds. The sounds
 * here are bare onomatopoeia, not the lyric.
 */

export type ToyOutcome =
  | { status: 'denied' } // unauthenticated: capability absent from the cap set
  | { status: 'inert' } // authenticated but under-privileged: present, no effect
  | { status: 'active'; sound: string } // admin: it works

/** The noises it makes, in order. */
export const TOY_SOUNDS = ['zip', 'bop', 'whirr'] as const

/**
 * Poke the toy as a given principal. `roles === null` models an unauthenticated
 * caller (no token → no principal). `n` selects the sound so the effect is
 * deterministic (no ambient randomness — same discipline as `beforeWrite`).
 */
export function poke(roles: readonly string[] | null, n = 0): ToyOutcome {
  if (roles == null) {
    return { status: 'denied' }
  }
  if (!roles.includes('admin')) {
    return { status: 'inert' }
  }
  return { status: 'active', sound: TOY_SOUNDS[n % TOY_SOUNDS.length] }
}
