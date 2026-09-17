import { COLLECTIONS } from './index'
import { ALL } from './access'
import { ROLES } from './roles'
import { RoleSchema } from '../../shared/role'

COLLECTIONS.role = {
  schema: RoleSchema,
  unique: ['name'],
  access: {
    // OWNER ONLY — not admin. See DECISIONS.md D4.
    //
    // `getUserRoles` derives every caller's roles FROM this collection, so
    // whoever can write it can rewrite the input to their own authorization.
    // Granting `admin` write here was the entire escalation chain: an admin
    // could PUT itself `developer`, and `developer` holds write on `module`,
    // whose documents are served as executable JavaScript via `/esm`. That is
    // admin → site takeover in two requests, demonstrated end-to-end in
    // `privilege-lifecycle.integration.test.ts`.
    //
    // `owner` is the in-system reflection of the Firestore account holder (D3),
    // so granting it total authority here costs nothing — that principal can
    // already edit the datastore directly. When `super` is added (D4) it joins
    // this map; `admin` does not.
    //
    // Key order is NO LONGER load-bearing (changed 2026-09-17). This comment
    // used to warn that `getMethodAccess` let the last matching role replace
    // earlier ones, so adding a less-privileged entry below this one would
    // silently reduce an owner's access. Grants are now joined as a lattice —
    // `ALL` absorbing, field maps unioned, predicates ORed — so the result is
    // independent of both config key order and role order. See `joinAccess` in
    // access.ts, and the permutation property test in access.test.ts.
    [ROLES.owner]: {
      read: ALL,
      write: ALL,
      list: ALL,
    },
  },
}
