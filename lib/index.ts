/**
 * service-compris — the decision layer of the tosijs service platform.
 *
 * *Service compris*: service included. Also — compris — **understood**, which is
 * the more load-bearing reading. What you get here is the part of a backend that
 * decides things, with no I/O, no vendor, and no environment: given a principal,
 * a collection config, and a proposed write, what should happen?
 *
 * ## Scope of 0.1.x — read this before depending on it
 *
 * This is **the decision kernel, not a server.** It does not talk to a database,
 * serve HTTP, or authenticate anyone. Those live in the deployable platform and
 * are not published yet. What is here is the piece that was worth extracting
 * first because it is pure, tested, and portable:
 *
 * - **the write pipeline** — existence guards, PUT/PATCH semantics, provenance
 *   stamping through an injected clock, envelope stripping, the no-op check, and
 *   uniqueness through an injected privileged read. Returns a typed outcome; the
 *   caller commits.
 * - **the access model** — role resolution across a collection's access map, with
 *   field-map straining, and a fail-closed rule for write restrictions the write
 *   path cannot enforce.
 * - **roles** — the role vocabulary and the `UserRoles` shape.
 *
 * Everything is dependency-injected, so it runs in a test with no emulator, no
 * network and no clock. That is the point: the decisions are the part you want to
 * be able to reason about, and they should not require a cloud to exercise.
 *
 * ## Stability
 *
 * 0.1.x. The *shape* is settled and under test; the surface will move. Several
 * design decisions are recorded but unimplemented — capability-based access,
 * schema-valued field permissions, and `isWriteAllowed` (which the monotonicity
 * property depends on) — and each will change this API when it lands. Pin exactly.
 *
 * @packageDocumentation
 */

export {
  runWritePipeline,
  isUnchanged,
  stripEnvelope,
  ENVELOPE_FIELDS,
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
  type UserContact,
  type UserRoles,
} from '../functions/src/collections/roles.js'
