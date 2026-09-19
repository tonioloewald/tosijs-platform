/**
 * The install system's own collections (A3, tosijs-platform#5).
 *
 * Installing is the most privileged write in the system — a manifest becomes
 * collection config, schemas and access rules — so these three records describe
 * a host's entire trust surface:
 *
 *   manifest     every manifest ever installed, verbatim, append-only
 *   grant        what each library is CURRENTLY permitted, and its active version
 *   install-log  what happened, when, and who did it
 *
 * ## None of them has `write` access. At all. For anyone.
 *
 * That is not an omission. `getMethodAccess` returns `undefined` for a method a
 * collection does not grant, so with no `write` entry `/doc` refuses POST, PUT,
 * PATCH and DELETE to every principal including `owner` — and these records are
 * written ONLY by the compiled install handler, which is not reachable from
 * `/doc` at all.
 *
 * This is the D13 confused-deputy fix expressed structurally rather than
 * policed: "authority to install is not authority to execute" only holds if
 * there is no ordinary document path that can forge a grant. A `configurator`
 * who could PUT `grant/virta` could award themselves any capability; a
 * `developer` who could PUT `manifest/...` could change what an installed
 * library means after it was approved.
 *
 * Reads are granted so that grants are ENUMERABLE — issue #5 asks for "a
 * board/filter query, not a database inspection". A host's operator should be
 * able to see what is installed and what it may do without opening the console.
 */

import { COLLECTIONS } from './index'
import { ALL } from './access'
import { ROLES } from './roles'

/**
 * Every manifest ever installed, keyed `<name>@<semver>`.
 *
 * Append-only by construction: a new version is a NEW document, never an edit,
 * so "what did we approve when we approved v1.2.0" always has an answer. That
 * matters when a later version asks for more — the diff is the thing a human is
 * being asked to approve, and it cannot be computed against a record that was
 * overwritten.
 */
COLLECTIONS.manifest = {
  cacheLatencySeconds: 60,
  access: {
    // Readable by those who can act on it. Not public: a manifest lists a
    // library's collections and access rules, which is a map of the host.
    [ROLES.configurator]: { read: ALL, list: ALL },
    [ROLES.owner]: { read: ALL, list: ALL },
  },
}

/**
 * What each installed library is currently allowed, keyed by namespace.
 *
 * `status` is what an uninstall changes — `revoked`, never deleted, and the rows
 * it governed are never dropped. Uninstalling a library must not be a way to
 * destroy data, and a tombstoned grant keeps the history enumerable so a
 * re-install can restore the same library to the same collections.
 */
COLLECTIONS.grant = {
  cacheLatencySeconds: 60,
  access: {
    [ROLES.configurator]: { read: ALL, list: ALL },
    [ROLES.owner]: { read: ALL, list: ALL },
  },
}

/**
 * The ledger: claims, installs, upgrades, revocations.
 *
 * Append-only and never edited. Its value is entirely in being a record nobody
 * can tidy — including the configurator whose actions it records, which is why
 * even they have no write access here.
 */
COLLECTIONS['install-log'] = {
  access: {
    [ROLES.configurator]: { read: ALL, list: ALL },
    [ROLES.owner]: { read: ALL, list: ALL },
  },
}
