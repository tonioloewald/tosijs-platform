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
    // NOTE: the key order of this map is load-bearing. `getMethodAccess`
    // iterates `Object.keys(config.access)` and the LAST matching role wins,
    // replacing earlier entries — so adding a less-privileged role *below* this
    // one would silently reduce an owner's access.
    [ROLES.owner]: {
      read: ALL,
      write: ALL,
      list: ALL,
    },
  },
}
