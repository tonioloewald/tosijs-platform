/**
 * Token pass-through — the enforcement baseline of the universal endpoint
 * (UNIVERSAL-ENDPOINT.md §2.1).
 *
 * A doc-store capability is BOUND to a principal (the identity resolved from the
 * caller's request token). Every read re-enters the SAME `getMethodAccess` RBAC
 * check as that principal — so whatever asks for data through this capability,
 * whether a direct `/doc` call or a procedure running on the caller's behalf, has
 * *exactly* the caller's rights. There is no stronger capability to hand out, so
 * amplification is structural, not policed.
 *
 * This is a runnable reference over the REAL access engine (`access.ts`); it does
 * not depend on the VM. The write side (beforeWrite/isWriteAllowed, §3/§4) is out
 * of scope here — this step is about the read/list rights the endpoint carries.
 */

import {
  getMethodAccess,
  ALL,
  collectionPath,
  type CollectionMap,
  type REST_METHOD,
} from './access'
import { type UserRoles } from './roles'

type Row = Record<string, unknown>

/** The backing document store the capability reads through (fast-or-slow oracle). */
export interface DocStore {
  get(path: string): Row | undefined
  list(collection: string): Array<{ id: string; data: Row }>
}

export interface StoreCapability {
  /** The principal this capability is bound to (from the caller's token). */
  readonly principal: UserRoles
  get(path: string, fields?: string[] | false): Promise<Row | undefined>
  list(collection: string, fields?: string[] | false): Promise<Row[]>
}

/**
 * Bind a store capability to `principal`. Nothing here can widen those rights;
 * the only way to get more is to be handed a capability bound to a stronger
 * principal — which token pass-through never does.
 */
export function makeStoreCapability(
  collections: CollectionMap,
  store: DocStore,
  principal: UserRoles
): StoreCapability {
  const strain = async (
    method: REST_METHOD,
    collection: string,
    row: Row,
    fields: string[] | false
  ): Promise<Row | undefined> => {
    const access = getMethodAccess(collections, collection, method, principal, fields)
    if (!access) return undefined // no access → invisible (opaque in the real endpoint)
    if (access === ALL) return row
    const out = await access(row, principal) // field-strain or row filter
    return out instanceof Error || out == null ? undefined : (out as Row)
  }

  return {
    principal,
    async get(path, fields = false) {
      const doc = store.get(path)
      if (!doc) return undefined
      return strain('GET', collectionPath(path), { ...doc, _path: path }, fields)
    },
    async list(collection, fields = false) {
      const rows = store.list(collection)
      const strained = await Promise.all(
        rows.map((r) =>
          strain('LIST', collectionPath(collection), { ...r.data, _path: `${collection}/${r.id}` }, fields)
        )
      )
      return strained.filter((r): r is Row => r != null)
    },
  }
}

/**
 * Run a "procedure": a function that ONLY ever receives the caller-bound
 * capability and cannot fabricate a stronger one. Modelling the ajs VM handing a
 * procedure its cap set — the reason a procedure's sub-request has exactly the
 * caller's rights.
 */
export function runProcedure<T>(
  capability: StoreCapability,
  proc: (cap: StoreCapability) => Promise<T>
): Promise<T> {
  return proc(capability)
}
