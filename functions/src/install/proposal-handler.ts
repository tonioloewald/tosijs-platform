/**
 * The install-proposal flow (board #2490), with its storage and the installer
 * handed in, so the flow itself runs under test.
 *
 * `proposal.ts` holds the pure decisions and `endpoint.ts` the HTTP and
 * Firestore. What sat between them (sweep, create, take, ask, approve, record)
 * used to live in the endpoint, where no test could reach it: a fix there was
 * pinned only by tests of its helpers, and reverting it left the suite green
 * (0.4.0 re-review R1). It lives here now, behind `ProposalStore` and
 * `Install`, the same split as `blob-handler.ts`.
 */
import { approvingFrom, decided, propose, proposalState, taken, type Proposal, type ProposeOutcome } from './proposal'
import { sweepExpired, type Sweepable } from '../sweep'

/** How an install answered: `error` when refused, `body` otherwise. */
export interface InstallResult {
  httpStatus: number
  error?: string
  message?: string
  extra?: Record<string, unknown>
  body?: Record<string, unknown>
}

export interface Principal {
  uid: string
  roles: readonly string[]
}

/** The installer (`runInstall` in the endpoint). */
export type Install = (input: {
  manifest: unknown
  principal: Principal
  approving?: Record<string, unknown>
  dryRun?: boolean
}) => Promise<InstallResult>

export interface ProposalStore extends Sweepable {
  /** Store a new proposal under a fresh id; never overwrites. */
  create(proposal: Proposal): Promise<string>
  read(id: string): Promise<Proposal | null>
  /**
   * Atomically apply `change` to the proposal if `allow` says so for what is
   * stored NOW. Returns whether it did. This is what makes approval single-use.
   */
  updateIf(id: string, allow: (current: Proposal | null) => boolean, change: Partial<Proposal>): Promise<boolean>
}

export interface ProposalDeps {
  store: ProposalStore
  install: Install
  /** The message of an error that means "this version is already on file with different content", else null. */
  conflictMessage: (e: unknown) => string | null
  onError: (what: string, e: unknown) => void
}

export type Proposed = { status: 'ok'; id: string; proposal: Proposal } | Exclude<ProposeOutcome, { status: 'ok' }>

/** Propose a manifest. Needs no credentials, so it cleans up after itself. */
export async function proposeManifest(
  deps: Pick<ProposalDeps, 'store' | 'onError'>,
  manifest: unknown,
  nowMs: number,
  random: Uint8Array
): Promise<Proposed> {
  const outcome = propose(manifest, nowMs, random)
  if (outcome.status !== 'ok') return outcome
  await sweepExpired(deps.store, nowMs, (e) => deps.onError('sweeping expired install proposals', e))
  const id = await deps.store.create(outcome.proposal)
  return { status: 'ok', id, proposal: outcome.proposal }
}

const NOT_PENDING: InstallResult = {
  httpStatus: 404,
  error: 'not-found',
  message: 'no pending install request with that id',
}

/**
 * Approve a proposal as `principal`: install THE STORED manifest, once.
 *
 * The caller has already established that `principal` is a configurator.
 */
export async function approveProposal(
  deps: ProposalDeps,
  input: { id: string; principal: Principal; nowMs: number }
): Promise<InstallResult> {
  const { store, install } = deps
  const { id, principal, nowMs } = input

  // Single use: take it first, atomically, so two clicks cannot both install.
  const took = await store.updateIf(
    id,
    (current) => proposalState(current, nowMs) === 'pending',
    taken(principal.uid, new Date(nowMs).toJSON())
  )
  if (!took) return NOT_PENDING
  const proposal = await store.read(id)
  if (!proposal) return NOT_PENDING

  let result: InstallResult
  try {
    // An upgrade that adds capabilities needs them approved. The page listed
    // every capability the manifest asks for, so approving the proposal
    // approves exactly the ones the host says are outstanding: ask (a dry run,
    // nothing committed), then install approving those.
    const asked = await install({ manifest: proposal.manifest, principal, dryRun: true })
    const approving =
      !asked.error && asked.body?.status === 'needs-approval' ? approvingFrom(asked.body.added) : undefined
    result = await install({ manifest: proposal.manifest, principal, approving })
    // Still outstanding (what is granted changed between the two): that is NOT
    // an install, and must never be recorded or reported as one. The installer
    // has parked the upgrade, as it does for any unapproved one.
    if (!result.error && result.body?.status === 'needs-approval') {
      result = {
        httpStatus: 409,
        error: 'conflict',
        message: 'the upgrade still needs capabilities approved, so it was parked, not applied. Propose it again.',
      }
    }
  } catch (e) {
    const conflict = deps.conflictMessage(e)
    if (conflict === null) deps.onError('approving an install proposal', e)
    result =
      conflict === null
        ? { httpStatus: 500, error: 'internal', message: 'install failed' }
        : { httpStatus: 409, error: 'conflict', message: conflict }
  }

  // Record the outcome for the CLI's poll. The install has already happened
  // (or not): failing to record it must not change the answer.
  try {
    await store.updateIf(
      id,
      (current) => current !== null,
      decided(
        result.error
          ? { failure: { error: result.error, message: result.message ?? '', ...(result.extra ?? {}) } }
          : { body: result.body }
      )
    )
  } catch (e) {
    deps.onError('recording an install proposal outcome', e)
  }
  return result
}
