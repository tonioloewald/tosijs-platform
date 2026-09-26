/**
 * service-compris — the decision layer of the tosijs service platform.
 *
 * *Service compris*: service included. Also — compris — **understood**, which is
 * the more load-bearing reading. What you get here is the part of a backend that
 * decides things, with no I/O, no vendor, and no environment: given a principal,
 * a collection config, and a proposed write, what should happen?
 *
 * ## Scope — read this before depending on it
 *
 * This is **the decision kernel, not a server.** It does not talk to a database,
 * serve HTTP, or authenticate anyone. Those live in the deployable platform
 * (this repository's `functions/`), which runs production hosts — tosijs-virta's
 * and loewald.com's — on exactly this kernel. What is here is the pure part:
 *
 * - **the write pipeline** — existence guards, PUT/PATCH semantics, provenance
 *   (`_created`, `_modified`, `_by`) stamped through an injected clock and the
 *   caller's roles, envelope stripping, the no-op check, `requireAttribution`,
 *   `immutable` (given a correct `exists`), and uniqueness through an injected
 *   privileged read. Returns a typed outcome; the caller commits.
 * - **the access model** — grants across a collection's access map JOINED as a
 *   lattice (holding more roles never grants less; key order is irrelevant),
 *   field-map straining, capability-token caveats that narrow every grant, and a
 *   fail-closed rule for write restrictions the write path cannot enforce.
 * - **roles** — the role vocabulary and the `UserRoles` shape.
 *
 * Some `CollectionConfig` fields are for the HOST, not the kernel: `seq` is
 * assigned by the host inside its commit transaction; `afterWrite` runs after
 * the host commits. The kernel carries them so one config describes a
 * collection.
 *
 * Everything is dependency-injected, so it runs in a test with no emulator, no
 * network and no clock.
 *
 * ## Stability (0.2.x)
 *
 * Settled, and changed within 0.2.x only to fix bugs: the exports below, the
 * `WriteOutcome` shape and its rejection reasons, the lattice-join semantics of
 * `getMethodAccess`, and the role vocabulary. A NEW rejection reason is a minor
 * release — it breaks exhaustive `switch`es, so it will be announced.
 *
 * Still provisional, and each will change this API when it lands:
 * `isWriteAllowed` (the monotonicity property depends on it) and schema-valued
 * field permissions (D5). Upgrading from 0.1.x: see the CHANGELOG's 0.2.0 entry.
 *
 * @packageDocumentation
 */

export {
  runWritePipeline,
  isUnchanged,
  stripEnvelope,
  ENVELOPE_FIELDS,
  STAMPED_FIELDS,
  type WriteMethod,
  type WriteOutcome,
  type WritePipelineDeps,
  type WritePipelineInput,
} from '../functions/src/collections/write-pipeline.js'

export {
  ALL,
  accessMap,
  collectionPath,
  getMethodAccess,
  hasPrivilegedRole,
  opaqueStatus,
  setAccessLogger,
  PRIVILEGED_ROLES,
  type AccessConfig,
  type AccessFilterFunc,
  type AccessLogger,
  type CollectionConfig,
  type CollectionMap,
  type FieldAccessMap,
  type REST_METHOD,
} from '../functions/src/collections/access.js'

export {
  ROLES,
  anonymousUser,
  type Role,
  type RoleName,
  type TokenContext,
  type UserContact,
  type UserRoles,
} from '../functions/src/collections/roles.js'
