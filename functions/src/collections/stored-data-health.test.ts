/**
 * Stored-data health check — does the CURRENT write gate accept the data we
 * already have?
 *
 * This is UNIVERSAL-ENDPOINT.md §6.3's "data-health / migration discovery" idea
 * applied to a specific risk at the 2026-09-16 write-pipeline cutover.
 *
 * ## Why this exists
 *
 * The cutover turned on `strict: true` for schema validation, because
 * tosijs-schema 1.9.0 stride-samples arrays past ~100 entries and a write gate
 * that samples isn't a gate (see `validate.test.ts`). That is a *tightening*:
 * data written years ago under the sampling default may contain a violation
 * nobody has ever seen, and the first person to discover it would be whoever
 * next tries to edit that document — the write would be rejected and the
 * document effectively frozen.
 *
 * Shadow mode could not have caught this. It only observes documents that are
 * written while it runs, so a legacy post nobody edits is invisible to it. This
 * checks all 849 of them.
 *
 * ## Why it reads a backup
 *
 * `scripts/backup-firestore.js` already takes a daily read-only snapshot of
 * production (one JSON file per document). Reading it needs no emulator, no
 * credentials and no network, and it is *real* production data rather than
 * fixtures — which is the entire point.
 *
 * ## Skip behaviour
 *
 * SKIPS LOUDLY when no snapshot is present, and does not pretend to pass. Per
 * the repo's standing rule, a skipped test is not a passing one.
 *
 * Run: cd functions && bun test src/collections/stored-data-health.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { validate as schemaValidate } from 'tosijs-schema'

import { ENVELOPE_FIELDS } from './write-pipeline'
import { PostSchema } from '../../shared/post'
import { PageSchema } from '../../shared/page'
import { ModuleSchema } from '../../shared/module'
import { RoleSchema } from '../../shared/role'

/**
 * Collection → schema, taken from `shared/` rather than from `COLLECTIONS`.
 *
 * `COLLECTIONS.post` and `.page` are registered by `blog.ts`/`page.ts`, which
 * import `utilities.ts`, which calls `admin.initializeApp()` at module scope —
 * so importing them here would make this test require Firebase to run. These
 * are the same schema objects those configs use; the indirection is what keeps
 * the check pure. `config` has no schema by design and is therefore absent.
 */
const SCHEMAS: Record<string, unknown> = {
  post: PostSchema,
  page: PageSchema,
  module: ModuleSchema,
  role: RoleSchema,
}

/**
 * Documents that ALREADY fail the gate, as of 2026-09-16. A RATCHET, not an
 * allowance: the assertion is `<=`, so the count may only go down.
 *
 * **These are not caused by the write-pipeline cutover.** Measured both ways
 * over the same snapshot, `strict: true` rejects exactly the same 748 posts the
 * current live (sampling) gate rejects — zero newly rejected. The cause is
 * unexpected properties, which tosijs-schema has always refused.
 *
 * What they are — note these fail in BOTH directions, which is the tell that
 * the schemas were written from an idealized model rather than from the data:
 *
 *   - **post (748/849)** — Appwrite migration residue: `$id`, `$createdAt`,
 *     `$updatedAt`, `$permissions`, `$collectionId`, `$databaseId`, `id`. None
 *     are in `PostSchema`. (Same migration lineage as issue #4, the missing
 *     2014-2015 posts.)
 *   - **page (2/2)** — one lacks `imageUrl`, which `PageSchema` marks REQUIRED;
 *     the other carries `css`, which `PageSchema` does not declare.
 *   - **module (2/2)** — both carry `type: 'js'`, undeclared in `ModuleSchema`;
 *     one predates `version`.
 *
 * Only `role` passes. `config` has no schema.
 *
 * Why this matters rather than being cosmetic: `blog.ts`'s editor loads a post
 * with `{...post}` (`editPost`) and PUTs the whole object back (`savePost` →
 * `tosiValue(blog.editorPost)`), so the residue reaches the write gate on every
 * save. Editing one of those 748 posts returns 400 today.
 *
 * Fixing it is a decision, not a cleanup — strip the residue from production
 * documents (a migration) or widen the schemas to match reality. Set these to 0
 * once chosen. It is also a precondition for installing the blog as a manifest:
 * you cannot verify a converted collection against a live oracle that rejects
 * 88% of its own data.
 */
const KNOWN_BAD: Record<string, number> = {
  // ALL ZERO as of 2026-09-17. Every stored document passes its own schema.
  //
  // Got here two ways: the schemas were widened to match reality (`page.css`
  // declared, `page.imageUrl` made optional, `module.type` declared), and
  // `scripts/migrate-schema-residue.js --apply` repaired 749 documents in
  // production — stripping Appwrite residue from 748 posts and backfilling one
  // module's `version`. Verified against a fresh snapshot: 0 posts with
  // residue, 0 modules without a version.
  //
  // Leaving the ratchet in place at 0 rather than deleting it: the value was
  // never "we know about these", it is "this can only go down".
  post: 0,
  page: 0,
  module: 0,
}

const BACKUP_ROOT = join(
  homedir(),
  'Backups',
  'tosijs-platform',
  'liquid-force-425209-g2'
)

/** Newest snapshot directory carrying a manifest, or null. */
const latestSnapshot = (): string | null => {
  if (!existsSync(BACKUP_ROOT)) return null
  const dirs = readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse()
  for (const d of dirs) {
    if (existsSync(join(BACKUP_ROOT, d, 'manifest.json'))) {
      return join(BACKUP_ROOT, d)
    }
  }
  return null
}

const snapshot = latestSnapshot()

/**
 * Invert the backup's tagged encoding — mirrors `decode()` in
 * `scripts/restore-firestore.js`, which is the code that would actually put this
 * data back. A backup file is `{_id, _collection, data}`, and Firestore natives
 * inside `data` are tagged (`{__type: 'timestamp' | 'bytes' | …}`).
 *
 * Getting this wrong is not a subtle failure: validating the raw file instead of
 * `data` rejects every document for missing every field, which looks exactly
 * like "all production data is invalid".
 */
const decode = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decode)
  const tagged = value as { __type?: unknown; value?: unknown }
  if (typeof tagged.__type === 'string') {
    switch (tagged.__type) {
      case 'timestamp':
      case 'bytes':
      case 'reference':
      case 'geopoint':
        return tagged.value
      default:
        throw new Error(`unknown tagged type ${tagged.__type}`)
    }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = decode(v)
  return out
}

/**
 * Validate a stored document exactly as the write path now would.
 *
 * The envelope strip mirrors `runWritePipeline`: `_id`/`_collection`/`_path` are
 * endpoint-owned and removed before validation, so a strict schema must not see
 * them. `_created`/`_modified` ARE part of the validated body today (the schemas
 * declare them), so they stay.
 */
const validateStored = (
  raw: Record<string, unknown>,
  schema: unknown
): string[] => {
  const body = decode(raw.data) as Record<string, unknown>
  for (const f of ENVELOPE_FIELDS) delete body[f]
  const errors: string[] = []
  schemaValidate(body, schema as never, {
    onError: (path: string, message: string) => {
      errors.push(`${path}: ${message}`)
    },
    strict: true,
  })
  return errors
}

describe('stored production data passes the current write gate', () => {
  if (!snapshot) {
    test('SKIPPED — no backup snapshot found', () => {
      console.warn(
        `\n   [SKIPPED] No snapshot under ${BACKUP_ROOT}.\n` +
          '   Stored-data health NOT verified. Run: bun run backup\n'
      )
      expect(snapshot).toBeNull()
    })
    return
  }

  const collections = readdirSync(snapshot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

  test('the snapshot actually contains documents', () => {
    // Guards against a green run over an empty directory.
    const total = collections.reduce(
      (n, c) => n + readdirSync(join(snapshot, c)).length,
      0
    )
    console.log(
      `   [stored-data-health] ${snapshot.split('/').pop()} — ` +
        `${total} documents across ${collections.join(', ')}`
    )
    expect(total).toBeGreaterThan(0)
  })

  for (const collection of collections) {
    test(`every stored ${collection} document validates`, () => {
      const schema = SCHEMAS[collection]
      if (!schema) {
        // No schema means no gate to fail — `config` has none by design.
        return
      }
      const files = readdirSync(join(snapshot, collection)).filter((f) =>
        f.endsWith('.json')
      )
      const failures: Array<{ file: string; errors: string[] }> = []
      for (const file of files) {
        const doc = JSON.parse(
          readFileSync(join(snapshot, collection, file), 'utf-8')
        ) as Record<string, unknown>
        const errors = validateStored(doc, schema)
        if (errors.length) failures.push({ file, errors })
      }
      if (failures.length) {
        // Group by message — 748 posts fail for 7 distinct reasons, and the
        // reasons are what you act on.
        const tally = new Map<string, number>()
        for (const f of failures) {
          for (const e of f.errors) tally.set(e, (tally.get(e) ?? 0) + 1)
        }
        console.error(
          `\n   ${failures.length}/${files.length} stored ${collection} documents ` +
            'would be REJECTED by the write gate:\n' +
            [...tally]
              .sort((a, b) => b[1] - a[1])
              .map(([e, n]) => `     ${n}x  ${e}`)
              .join('\n') +
            `\n     e.g. ${failures[0].file}`
        )
      }
      expect(failures.length).toBeLessThanOrEqual(KNOWN_BAD[collection] ?? 0)
    })
  }
})
