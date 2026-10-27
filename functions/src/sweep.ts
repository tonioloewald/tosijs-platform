/**
 * Cleaning up short-lived requests that anyone may create.
 *
 * `/authorize?action=start` and `/install?action=propose` need no credentials
 * and each stores a document, so something has to delete them (0.4.0 review
 * B3). The rule is the same for both, so it lives here once: creating a request
 * deletes a batch of old ones. A flood therefore cleans up after itself, and
 * what an anonymous caller can make a host hold is bounded by the size limit on
 * one request and the rate limit, for the life of a request.
 *
 * There is deliberately NO cap on how many may be pending. A cap is a lockout
 * lever: a handful of anonymous requests every few minutes would refuse every
 * legitimate one (0.4.0 re-review).
 *
 * Best effort, always: cleanup never fails the request that triggered it.
 */
import type { Store } from './collections/store'

/** Requests deleted per call. More than one, so deletion outpaces creation. */
export const SWEEP_BATCH = 50
/**
 * How long past its expiry a request is kept. An approval taken just before
 * expiry is still writing its outcome a moment after it; deleting the record
 * under it turned a committed install into a 500 (0.4.0 re-review).
 */
export const SWEEP_GRACE_MS = 10 * 60 * 1000

/**
 * May a request with this expiry be deleted? `expiresAt` is an ISO string. One
 * that does not parse is deletable: it can never be approved, and it must not
 * be kept forever for being malformed.
 */
export function isSweepable(expiresAt: unknown, nowMs: number): boolean {
  const expires = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN
  return !Number.isFinite(expires) || nowMs > expires + SWEEP_GRACE_MS
}

/** The cutoff a store can pre-filter on: ISO strings sort as time. */
export const sweepCutoff = (nowMs: number): string => new Date(nowMs - SWEEP_GRACE_MS).toJSON()

/** What a sweep needs from wherever the requests are kept. */
export interface Sweepable {
  /** Up to `limit` requests whose `expiresAt` sorts before `cutoffIso`. */
  expiredBefore(cutoffIso: string, limit: number): Promise<Array<{ id: string; expiresAt: unknown }>>
  remove(ids: string[]): Promise<void>
}

/** Delete a batch of finished requests. Returns how many; never throws. */
export async function sweepExpired(
  store: Sweepable,
  nowMs: number,
  onError: (e: unknown) => void = () => undefined
): Promise<number> {
  try {
    const candidates = await store.expiredBefore(sweepCutoff(nowMs), SWEEP_BATCH)
    // The store's query is only a pre-filter; this is the rule.
    const ids = candidates.filter((c) => isSweepable(c.expiresAt, nowMs)).map((c) => c.id)
    if (ids.length) await store.remove(ids)
    return ids.length
  } catch (e) {
    onError(e)
    return 0
  }
}

/**
 * A collection of requests, each with an ISO `expiresAt`, in any store. The
 * query is exactly the Firestore one this replaced (`expiresAt < cutoff`,
 * projected, limited, no explicit order), so it needs no new index.
 */
export function storeSweepable(store: Pick<Store, 'query' | 'delete'>, collection: string): Sweepable {
  return {
    async expiredBefore(cutoffIso, limit) {
      const rows = await store.query(collection, {
        lessThan: { field: 'expiresAt', value: cutoffIso },
        orderBy: '~',
        fields: ['expiresAt'],
        limit,
      })
      return rows.map((d) => ({ id: d.path.split('/').pop() as string, expiresAt: d.data.expiresAt }))
    },
    async remove(ids) {
      // Not a batch: a sweep is best effort, and a partly-finished one is
      // simply finished by the next.
      await Promise.all(ids.map((id) => store.delete(`${collection}/${id}`)))
    },
  }
}

/** In memory (for tests), with the same pre-filter a Firestore query applies: a string comparison. */
export const memorySweepable = (rows: Map<string, { expiresAt: unknown }>): Sweepable => ({
  async expiredBefore(cutoffIso, limit) {
    return [...rows]
      .filter(([, r]) => typeof r.expiresAt === 'string' && r.expiresAt < cutoffIso)
      .slice(0, limit)
      .map(([id, r]) => ({ id, expiresAt: r.expiresAt }))
  },
  async remove(ids) {
    for (const id of ids) rows.delete(id)
  },
})
