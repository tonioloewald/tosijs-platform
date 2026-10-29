/**
 * The transactional write, bound to Firestore.
 *
 * What a commit decides lives in the kernel (`collections/commit.ts`); this
 * binds it to Firestore transactions and Cloud Logging, with the signature its
 * callers (`/doc`, `/docs`, `/blob`) already use.
 */
import { log } from './log'
import type { CollectionMap } from './collections/access'
import type { UserRoles } from './collections/roles'
import {
  commitWrites,
  type CommitOutcome,
  type TransactionalWrite,
} from './collections/commit'
import { firestoreStore } from './firestore-store'

export type { CommitOutcome, Refusal, TransactionalWrite } from './collections/commit'

export function commitTransactionally(
  writes: TransactionalWrite[],
  collections: CollectionMap,
  userRoles: UserRoles
): Promise<CommitOutcome> {
  return commitWrites(firestoreStore, writes, collections, userRoles, {
    warn: (message, error) => log.warn(message, error),
  })
}
