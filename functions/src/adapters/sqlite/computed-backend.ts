/**
 * The render cache's backend (`ComputedBackend`, render/computed.ts) on
 * SQLite, sharing a SqliteStore's connection, write queue and lock.
 *
 * Two tables beside `documents`:
 *   computed(collection, key, entry, version)  — values, one row per key
 *   computed_log(collection, dep, at)          — when each dep was invalidated
 *
 * `version` is an integer bumped on every write, so `writeIfUnchanged` is a
 * compare-and-set: read the version and write, inside one exclusive step. The
 * same render-cache suite (render/computed.suite.ts) runs on this and on
 * MemoryBackend.
 */
import type { ComputedBackend, Entry } from '../../render/computed'
import type { SqliteStore } from './store'

type Row = { key: string; entry: string; version: number }

const CHUNK = 500 // bound the parameters in one statement

export function sqliteComputedBackend(
  store: SqliteStore,
  collection: string,
  logCollection: string,
  now: () => number = Date.now
): ComputedBackend {
  store.reading((db) => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS computed (collection TEXT NOT NULL, key TEXT NOT NULL, ' +
        'entry TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (collection, key)) WITHOUT ROWID'
    )
    db.exec(
      'CREATE TABLE IF NOT EXISTS computed_log (collection TEXT NOT NULL, dep TEXT NOT NULL, ' +
        'at INTEGER NOT NULL, PRIMARY KEY (collection, dep)) WITHOUT ROWID'
    )
  })

  const readOne = (key: string) =>
    store.reading(
      (db) =>
        db.query('SELECT key, entry, version FROM computed WHERE collection = ? AND key = ?').get(collection, key) as Row | null
    )
  const asRead = (row: Row | null) =>
    row ? { entry: JSON.parse(row.entry) as Entry, version: String(row.version) } : { entry: undefined, version: null }

  return {
    async read(key) {
      return asRead(readOne(key))
    },
    async readMany(keys) {
      return keys.map((key) => asRead(readOne(key)))
    },
    writeIfUnchanged(key, entry, expected) {
      // Every field written, so a recompute never inherits an old `check` or `stale`.
      const full: Entry = { value: entry.value, deps: entry.deps ?? [], computedAt: entry.computedAt }
      if (entry.check !== undefined) full.check = entry.check
      return store.exclusive((db) => {
        const row = db
          .query('SELECT version FROM computed WHERE collection = ? AND key = ?')
          .get(collection, key) as { version: number } | null
        if ((row ? String(row.version) : null) !== expected) return false // a lost race
        db.query('INSERT OR REPLACE INTO computed (collection, key, entry, version) VALUES (?, ?, ?, ?)').run(
          collection,
          key,
          JSON.stringify(full),
          (row?.version ?? 0) + 1
        )
        return true
      })
    },
    async writeAll(entries) {
      // Merge: a stale marker keeps the recorded deps, so cascades still find it.
      await store.exclusive((db) => {
        for (const [key, entry] of entries) {
          const row = db
            .query('SELECT entry, version FROM computed WHERE collection = ? AND key = ?')
            .get(collection, key) as { entry: string; version: number } | null
          const merged = { ...(row ? JSON.parse(row.entry) : {}), ...entry }
          db.query('INSERT OR REPLACE INTO computed (collection, key, entry, version) VALUES (?, ?, ?, ?)').run(
            collection,
            key,
            JSON.stringify(merged),
            (row?.version ?? 0) + 1
          )
        }
      })
    },
    async dependents(deps) {
      const out = new Set<string>()
      for (let i = 0; i < deps.length; i += CHUNK) {
        const chunk = deps.slice(i, i + CHUNK)
        const rows = store.reading(
          (db) =>
            db
              .query(
                'SELECT key FROM computed WHERE collection = ? AND EXISTS (SELECT 1 FROM json_each(entry, ' +
                  `'$.deps') WHERE value IN (${chunk.map(() => '?').join(', ')}))`
              )
              .all(collection, ...chunk) as Array<{ key: string }>
        )
        for (const { key } of rows) out.add(key)
      }
      return [...out]
    },
    async logInvalidation(deps) {
      const at = now()
      await store.exclusive((db) => {
        const upsert = db.query('INSERT OR REPLACE INTO computed_log (collection, dep, at) VALUES (?, ?, ?)')
        for (const dep of deps) upsert.run(logCollection, dep, at)
      })
    },
    async invalidatedSince(deps, sinceMs) {
      for (let i = 0; i < deps.length; i += CHUNK) {
        const chunk = deps.slice(i, i + CHUNK)
        const hit = store.reading((db) =>
          db
            .query(
              `SELECT 1 FROM computed_log WHERE collection = ? AND at >= ? AND dep IN (${chunk
                .map(() => '?')
                .join(', ')}) LIMIT 1`
            )
            .get(logCollection, sinceMs, ...chunk)
        )
        if (hit) return true
      }
      return false
    },
  }
}
