/**
 * The `/authorize` request's lifecycle, over the store port
 * (SOVEREIGN-PLAN.md Phase 1).
 *
 * `authorize.ts` decides; this applies the decisions atomically. Moved from
 * `authorize-endpoint.ts` — and moved INTO transactions, which closed a race:
 * the endpoint read a request, decided, then wrote, so two exchanges presenting
 * one verifier could both see "approved, unused" and both mint a credential
 * (and an approval and a denial could both land). Each step now re-reads the
 * request inside the transaction that writes it and re-runs the same pure
 * decision on what it finds.
 */
import { newDocId, updateDocumentIf, type Store } from '../collections/store'
import { AUTHORIZE_COLLECTION, decideApprove, decideExchange, type AuthorizeRequest } from './authorize'
import { decideMint, hashToken, newTokenSecret } from './token'

export const TOKEN_COLLECTION = 'token'

const requestPath = (id: string) => `${AUTHORIZE_COLLECTION}/${id}`

const asRequest = (id: string, data: Record<string, unknown> | null) =>
  data ? ({ ...data, _id: id } as unknown as AuthorizeRequest) : null

/** The stored request, or null (an empty id is null, never a read). */
export async function readRequest(store: Pick<Store, 'get'>, id: string): Promise<AuthorizeRequest | null> {
  if (!id) return null
  const doc = await store.get(requestPath(id))
  return asRequest(id, doc.exists ? doc.data : null)
}

/** Deny, only while still pending. Denying needs no sign-in: it can only stop a flow. */
export function denyRequest(store: Pick<Store, 'transaction'>, id: string): Promise<boolean> {
  if (!id) return Promise.resolve(false)
  return updateDocumentIf(store, requestPath(id), (r) => r?.status === 'pending', { status: 'denied' })
}

/** Approve as `principalUid`, deciding on the request as it is stored at commit. */
export function approveRequest(
  store: Pick<Store, 'transaction'>,
  id: string,
  approver: { uid: string; name?: string },
  now: Date
): Promise<{ decision: ReturnType<typeof decideApprove>; record: AuthorizeRequest | null }> {
  return store.transaction(async (tx) => {
    const doc = id ? await tx.get(requestPath(id)) : null
    const record = asRequest(id, doc?.exists ? doc.data : null)
    const decision = decideApprove(record, approver.uid, now.getTime(), now.toJSON(), approver.name)
    if (decision.status === 'approved') tx.set(requestPath(id), decision.patch, { merge: true })
    return { decision, record }
  })
}

export type ExchangeOutcome =
  | { status: 'pending' }
  | { status: 'refused'; reason: string }
  | { status: 'mint-refused'; problems: string[] }
  | {
      status: 'ready'
      tokenId: string
      secret: string
      principalUid: string
      record: { label: string; caveats: { roles: string[] }; expiresAt: string }
    }

/**
 * Exchange an approved request for a token, at most once.
 *
 * The mint uses the approver's LIVE roles (`rolesOf`), read at exchange time,
 * not at approval — so a revocation between approving and collecting takes
 * effect. That read cannot be inside the transaction (it is a query over a
 * different collection, and the decision it feeds is pure), so the request is
 * decided once outside to learn whose roles to read, then decided AGAIN inside
 * the transaction that consumes it. Only the second decision can mint.
 */
export async function exchangeRequest(
  store: Pick<Store, 'get' | 'transaction'>,
  id: string,
  verifier: string,
  deps: { rolesOf: (uid: string) => Promise<string[]>; now?: () => Date }
): Promise<ExchangeOutcome> {
  const now = (deps.now ?? (() => new Date()))()
  const first = decideExchange(await readRequest(store, id), verifier, now.getTime())
  if (first.status !== 'ready') return first

  const mint = decideMint({
    principalUid: first.principalUid,
    principalRoles: await deps.rolesOf(first.principalUid),
    viaToken: false,
    label: first.label,
    caveats: first.caveats,
    ttlMs: first.ttlMs,
    nowIso: now.toJSON(),
  })
  if (mint.status === 'refused') return { status: 'mint-refused', problems: mint.problems }

  // Drawn outside the body: a store may retry it, and a retry must not mint a
  // second secret.
  const secret = newTokenSecret()
  const tokenId = newDocId()
  const createdAt = mint.record.createdAt

  return store.transaction(async (tx) => {
    const doc = await tx.get(requestPath(id))
    const again = decideExchange(asRequest(id, doc.exists ? doc.data : null), verifier, now.getTime())
    // Consumed (or changed) since the first look: this exchange lost.
    if (again.status !== 'ready' || again.principalUid !== first.principalUid) {
      return again.status === 'refused' ? again : { status: 'refused', reason: 'used' }
    }
    // The token and the consumption in ONE commit, so a crash cannot leave a
    // request still exchangeable for a second credential.
    tx.set(`${TOKEN_COLLECTION}/${tokenId}`, {
      ...mint.record,
      // The approver's name, captured when they approved (#28).
      ...(again.principalName ? { principalName: again.principalName } : {}),
      hash: hashToken(secret),
      _created: createdAt,
      _modified: createdAt,
    })
    tx.set(requestPath(id), { usedAt: createdAt }, { merge: true })
    return {
      status: 'ready' as const,
      tokenId,
      secret,
      principalUid: first.principalUid,
      record: { label: mint.record.label, caveats: mint.record.caveats, expiresAt: mint.record.expiresAt },
    }
  })
}
