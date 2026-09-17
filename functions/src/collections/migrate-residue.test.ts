/**
 * Does the residue migration actually work — on the real data, before it runs?
 *
 * `scripts/migrate-schema-residue.js` repairs 752 production documents. A
 * migration whose logic is only ever exercised by running it against production
 * is not tested, so this imports its pure decision functions and replays them
 * over the newest backup snapshot: no credentials, no network, no writes.
 *
 * What it proves:
 *   1. every document the migration plans to repair comes out schema-VALID;
 *   2. it repairs everything that needs repairing (no silent under-coverage);
 *   3. it is idempotent — re-running plans nothing;
 *   4. it is minimal — it only ever deletes known residue keys, and never
 *      touches content, provenance, or a document that was already fine.
 *
 * (4) is the one that matters most. The failure mode of a bulk repair is not
 * "doesn't fix it", it is "fixes it and quietly damages something else", and
 * `_created`/`_modified` are deliberately preserved (see the script's header).
 *
 * SKIPS LOUDLY without a snapshot — a skipped test is not a passing one.
 *
 * Run: cd functions && bun test src/collections/migrate-residue.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain JS module, no declarations
import {
  planRepair,
  applyPlan,
  validateAgainst,
  APPWRITE_RESIDUE,
  SCHEMAS,
} from '../../../scripts/migrate-schema-residue.js'

const BACKUP_ROOT = join(
  homedir(),
  'Backups',
  'tosijs-platform',
  'liquid-force-425209-g2'
)

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

/** Mirrors `decode()` in restore-firestore.js — see stored-data-health.test.ts. */
const decode = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decode)
  const tagged = value as { __type?: unknown; value?: unknown }
  if (typeof tagged.__type === 'string') return tagged.value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = decode(v)
  return out
}

const snapshot = latestSnapshot()

const loadAll = (collection: string): Array<[string, Record<string, unknown>]> =>
  readdirSync(join(snapshot as string, collection))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const raw = JSON.parse(
        readFileSync(join(snapshot as string, collection, f), 'utf-8')
      )
      return [f, decode(raw.data) as Record<string, unknown>]
    })

describe('migrate-schema-residue, replayed over the real backup', () => {
  if (!snapshot) {
    test('SKIPPED — no backup snapshot found', () => {
      console.warn(
        `\n   [SKIPPED] No snapshot under ${BACKUP_ROOT}.\n` +
          '   Migration logic NOT verified. Run: bun run backup\n'
      )
      expect(snapshot).toBeNull()
    })
    return
  }

  const collections = Object.keys(SCHEMAS).filter((c) =>
    existsSync(join(snapshot, c))
  )

  for (const collection of collections) {
    describe(collection, () => {
      const docs = loadAll(collection)

      test('every planned repair yields a schema-valid document', () => {
        const stillBad: string[] = []
        let repaired = 0
        for (const [file, data] of docs) {
          const plan = planRepair(collection, data)
          if (!plan) continue
          repaired++
          const errors = validateAgainst(collection, applyPlan(data, plan))
          if (errors.length) stillBad.push(`${file}: ${errors.join('; ')}`)
        }
        console.log(`   [${collection}] plans ${repaired}/${docs.length} repairs`)
        expect(stillBad).toEqual([])
      })

      test('nothing is left behind — no document still fails after repair', () => {
        // Under-coverage is the quiet failure: a migration that fixes most of
        // the problem looks like success until someone edits the remainder.
        const unfixed: string[] = []
        for (const [file, data] of docs) {
          const plan = planRepair(collection, data)
          const body = plan ? applyPlan(data, plan) : { ...data }
          if (!plan) {
            for (const k of ['_id', '_collection', '_path']) delete body[k]
          }
          if (validateAgainst(collection, body).length) unfixed.push(file)
        }
        expect(unfixed).toEqual([])
      })

      test('is idempotent — a repaired document plans no further repair', () => {
        for (const [file, data] of docs) {
          const plan = planRepair(collection, data)
          if (!plan) continue
          const again = planRepair(collection, applyPlan(data, plan))
          if (again) {
            throw new Error(`${file} would be repaired twice`)
          }
        }
        expect(true).toBe(true)
      })

      test('only ever removes known residue keys, never content', () => {
        const allowedDeletes = new Set<string>(APPWRITE_RESIDUE)
        for (const [file, data] of docs) {
          const plan = planRepair(collection, data)
          if (!plan) continue
          for (const key of plan.deletes as string[]) {
            if (!allowedDeletes.has(key)) {
              throw new Error(`${file}: would delete unexpected key "${key}"`)
            }
          }
        }
        expect(true).toBe(true)
      })

      test('preserves provenance and every surviving field verbatim', () => {
        for (const [file, data] of docs) {
          const plan = planRepair(collection, data)
          if (!plan) continue
          const after = applyPlan(data, plan) as Record<string, unknown>
          // _created / _modified are deliberately NOT re-stamped: these
          // documents are being repaired, not edited.
          expect(after._created).toEqual(data._created)
          expect(after._modified).toEqual(data._modified)
          for (const [k, v] of Object.entries(data)) {
            if ((plan.deletes as string[]).includes(k)) continue
            if (k in (plan.sets as object)) continue
            if (['_id', '_collection', '_path'].includes(k)) continue
            if (JSON.stringify(after[k]) !== JSON.stringify(v)) {
              throw new Error(`${file}: field "${k}" was altered`)
            }
          }
        }
        expect(true).toBe(true)
      })

      test('leaves already-valid documents completely alone', () => {
        for (const [file, data] of docs) {
          const body = { ...data }
          for (const k of ['_id', '_collection', '_path']) delete body[k]
          if (validateAgainst(collection, body).length) continue
          if (planRepair(collection, data)) {
            throw new Error(`${file} is already valid but would be rewritten`)
          }
        }
        expect(true).toBe(true)
      })
    })
  }
})
