#!/usr/bin/env bun

/**
 * One-off migration: make stored documents pass their own schemas.
 *
 * ## The problem this fixes
 *
 * Validating every stored production document against its schema (2026-09-16,
 * `functions/src/collections/stored-data-health.test.ts`) found that 752 of 854
 * schema-bearing documents would be REJECTED by the write gate — not because of
 * any recent change, but because they always would have been. tosijs-schema
 * rejects unexpected properties, and:
 *
 *   - 748 of 849 posts carry Appwrite migration residue (`$id`, `$createdAt`,
 *     `$updatedAt`, `$permissions`, `$collectionId`, `$databaseId`, `id`).
 *   - one module predates the `version` field.
 *
 * `blog.ts` loads a post with `{...post}` and PUTs the whole object back, so the
 * residue reaches the gate on every save: those 748 posts could not be edited.
 * The evidence is in the data — no residue-carrying post has been modified since
 * 2025-11-01, while clean posts were edited as recently as 2026-09-01.
 *
 * The other half of the fix is in the schemas (`shared/page.ts` gained `css` and
 * made `imageUrl` optional; `shared/module.ts` gained `type`) — those needed no
 * data migration, only this script's counterpart change.
 *
 * ## Why it writes to Firestore directly rather than through /doc
 *
 * `/doc` would re-stamp `_modified` on all 748 documents, marking a decade of
 * posts as edited today. They were not edited — they were repaired — and
 * `_modified` feeds SEO/lastmod signals. So this uses the admin SDK with
 * `FieldValue.delete()` to remove exactly the offending keys and touches nothing
 * else. Provenance is preserved deliberately.
 *
 * That means it bypasses validation and RBAC, which is only acceptable because
 * it makes documents MORE valid, never less: it deletes keys the schema forbids
 * and fills one the schema requires. It verifies each document against the real
 * schema before writing, and skips anything that does not come out clean.
 *
 * ## Safety
 *
 * - **DRY RUN BY DEFAULT.** `--apply` is required to write anything.
 * - Refuses to run without a backup snapshot newer than 24h.
 * - Verifies the post-migration shape against the live schema per document, and
 *   skips (never writes) any document that would still fail.
 * - Batched with a size cap; reports exactly what it changed.
 *
 * Usage:
 *   bun scripts/migrate-schema-residue.js              # dry run (default)
 *   bun scripts/migrate-schema-residue.js --apply      # actually write
 *   bun scripts/migrate-schema-residue.js --apply --collection post
 *
 * Auth: application default credentials, same as scripts/seed-production.js.
 * If it fails with a credentials error: gcloud auth application-default login
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { validate } from 'tosijs-schema'

import { PostSchema } from '../functions/shared/post.ts'
import { PageSchema } from '../functions/shared/page.ts'
import { ModuleSchema } from '../functions/shared/module.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

// firebase-admin is installed under functions/ (npm-managed), not at the root —
// same reason and same resolution as scripts/backup-firestore.js. Loaded INSIDE
// main() rather than at module scope so importing this file for its pure repair
// logic neither needs firebase-admin nor touches credentials.
const adminDir = path.join(
  projectRoot,
  'functions',
  'node_modules',
  'firebase-admin'
)
const loadAdmin = async () => ({
  ...(await import(`${adminDir}/lib/app/index.js`)),
  ...(await import(`${adminDir}/lib/firestore/index.js`)),
})

const args = process.argv.slice(2)
const has = (n) => args.includes(`--${n}`)
const valueOf = (n) => {
  const i = args.indexOf(`--${n}`)
  return i !== -1 ? args[i + 1] : undefined
}

const APPLY = has('apply')
const ONLY = valueOf('collection')

/**
 * Appwrite export leftovers. Every one of these is absent from PostSchema.
 *
 * Exported, with `planRepair`/`applyPlan`/`validateAgainst`, so the migration's
 * decisions can be exercised over the real backup WITHOUT credentials or a
 * write — see `functions/src/collections/migrate-residue.test.ts`. A migration
 * whose logic is only ever tested by running it against production is not
 * tested.
 */
export const APPWRITE_RESIDUE = [
  '$id',
  '$createdAt',
  '$updatedAt',
  '$permissions',
  '$collectionId',
  '$databaseId',
  'id',
]

/** Envelope fields the endpoint owns — never part of the validated body. */
const ENVELOPE = ['_id', '_collection', '_path']

export const SCHEMAS = { post: PostSchema, page: PageSchema, module: ModuleSchema }

/**
 * Per-collection repair. Returns `{ deletes, sets }` describing the minimal
 * change, or null when the document is already fine.
 */
export function planRepair(collection, data) {
  const deletes = []
  const sets = {}

  if (collection === 'post') {
    for (const key of APPWRITE_RESIDUE) {
      if (key in data) deletes.push(key)
    }
  }

  if (collection === 'module' && typeof data.version !== 'string') {
    // Backfill rather than relaxing ModuleSchema's `\d+.\d+.\d+` pattern — the
    // constraint is worth keeping, and 0.0.0 is what `emptyModule` uses.
    sets.version = '0.0.0'
  }

  if (!deletes.length && !Object.keys(sets).length) return null
  return { deletes, sets }
}

/** The document as it WILL be, for pre-write verification. */
export function applyPlan(data, plan) {
  const next = { ...data, ...plan.sets }
  for (const key of plan.deletes) delete next[key]
  for (const key of ENVELOPE) delete next[key]
  return next
}

export function validateAgainst(collection, body) {
  const errors = []
  validate(body, SCHEMAS[collection], {
    onError: (p, m) => errors.push(`${p}: ${m}`),
    strict: true,
  })
  return errors
}

function getProjectId() {
  const firebaserc = JSON.parse(
    fs.readFileSync(path.join(projectRoot, '.firebaserc'), 'utf-8')
  )
  return firebaserc.projects?.default
}

/** Refuse to touch production without a recent snapshot to fall back on. */
function assertRecentBackup(projectId) {
  const root = path.join(os.homedir(), 'Backups', 'tosijs-platform', projectId)
  if (!fs.existsSync(root)) {
    throw new Error(
      `No backup root at ${root}. Run: bun run backup — before migrating.`
    )
  }
  const snaps = fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        /^\d{4}-\d{2}-\d{2}T/.test(e.name) &&
        fs.existsSync(path.join(root, e.name, 'manifest.json'))
    )
    .map((e) => e.name)
    .sort()
  const newest = snaps[snaps.length - 1]
  if (!newest) {
    throw new Error(`No complete snapshot under ${root}. Run: bun run backup`)
  }
  const takenAt = new Date(
    JSON.parse(
      fs.readFileSync(path.join(root, newest, 'manifest.json'), 'utf-8')
    ).takenAt
  )
  const ageHours = (Date.now() - takenAt.getTime()) / 36e5
  if (ageHours > 24) {
    throw new Error(
      `Newest backup is ${ageHours.toFixed(1)}h old (${newest}). ` +
        'Run: bun run backup — before migrating.'
    )
  }
  return { newest, ageHours }
}

async function main() {
  const projectId = getProjectId()
  if (!projectId) {
    console.error('Could not read project ID from .firebaserc')
    process.exit(1)
  }

  const backup = assertRecentBackup(projectId)
  console.log(
    `Backup: ${backup.newest} (${backup.ageHours.toFixed(1)}h old) — OK\n`
  )

  const { initializeApp, getFirestore, FieldValue } = await loadAdmin()
  initializeApp({ projectId })
  const db = getFirestore()

  const collections = ONLY ? [ONLY] : Object.keys(SCHEMAS)
  let totalPlanned = 0
  let totalWritten = 0
  let totalSkipped = 0

  for (const collection of collections) {
    if (!SCHEMAS[collection]) {
      console.error(`Unknown collection "${collection}"`)
      process.exit(1)
    }
    const snapshot = await db.collection(collection).get()
    const planned = []
    const skipped = []

    snapshot.forEach((doc) => {
      const data = doc.data()
      const plan = planRepair(collection, data)
      if (!plan) return
      const errors = validateAgainst(collection, applyPlan(data, plan))
      if (errors.length) {
        // The repair does not make this document valid — leave it ALONE and
        // report it. A partial fix that still fails the gate is worse than an
        // untouched document, because it looks handled.
        skipped.push({ id: doc.id, errors })
        return
      }
      planned.push({ id: doc.id, plan })
    })

    console.log(
      `${collection}: ${snapshot.size} documents, ${planned.length} to repair` +
        (skipped.length ? `, ${skipped.length} SKIPPED (still invalid)` : '')
    )
    for (const s of skipped.slice(0, 10)) {
      console.log(`   SKIP ${s.id}: ${s.errors.join('; ')}`)
    }
    if (planned.length) {
      const sample = planned[0]
      console.log(
        `   e.g. ${sample.id}: ` +
          [
            sample.plan.deletes.length
              ? `delete ${sample.plan.deletes.join(', ')}`
              : null,
            Object.keys(sample.plan.sets).length
              ? `set ${JSON.stringify(sample.plan.sets)}`
              : null,
          ]
            .filter(Boolean)
            .join('; ')
      )
    }

    totalPlanned += planned.length
    totalSkipped += skipped.length

    if (APPLY && planned.length) {
      const BATCH = 400 // Firestore caps a batch at 500 writes
      for (let i = 0; i < planned.length; i += BATCH) {
        const batch = db.batch()
        for (const { id, plan } of planned.slice(i, i + BATCH)) {
          const update = { ...plan.sets }
          for (const key of plan.deletes) update[key] = FieldValue.delete()
          batch.update(db.collection(collection).doc(id), update)
        }
        await batch.commit()
        totalWritten += Math.min(BATCH, planned.length - i)
        console.log(
          `   committed ${Math.min(i + BATCH, planned.length)}/${planned.length}`
        )
      }
    }
  }

  console.log()
  if (APPLY) {
    console.log(`APPLIED — repaired ${totalWritten} documents.`)
  } else {
    console.log(
      `DRY RUN — ${totalPlanned} documents would be repaired. ` +
        'Re-run with --apply to write.'
    )
  }
  if (totalSkipped) {
    console.log(
      `${totalSkipped} document(s) were NOT repaired and still fail their schema.`
    )
  }
}

// Only run as a CLI. Imported (by the test) this module is pure.
if (import.meta.main) {
  main().catch((e) => {
    console.error(`\nMigration failed: ${e.message}`)
    process.exit(1)
  })
}
