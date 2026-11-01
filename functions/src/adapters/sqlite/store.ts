/**
 * The Store port on SQLite (`bun:sqlite`): SOVEREIGN-PLAN.md Phase 2, §4.
 *
 * One table, every collection in it, documents as JSON:
 *
 *   documents(collection, id, data)  PRIMARY KEY (collection, id)
 *
 * `collection` is the LOGICAL path (`post`, `blog:public`, `post/abc/comment`):
 * `:` and `/` are legal in a column value, so nothing is renamed.
 *
 * ## Firestore is the reference
 *
 * The conformance suite (collections/store.suite.ts) holds this to what
 * Firestore does, and SQLite gets most of it for free:
 * - strings compare as UTF-8 bytes (the BINARY collation), as Firestore's do;
 * - `json_type` tells a missing field (NULL) from a stored `null` ('null'),
 *   which ordering needs: ordering by a field excludes documents without it;
 * - comparisons check the JSON type first, because SQLite would otherwise call
 *   `true` equal to `1` (both bind as integers) and Firestore does not.
 * A field in a query option is a field PATH (`meta.title`), as Firestore
 * reads it. Equality on a map or array (`equals`, `oneOf`, `arrayContains` with an
 * object) compares by CONTENT, ignoring key order, which SQL cannot express
 * over JSON text; those conditions are applied in JS after the SQL ones, and
 * `limit` with them.
 *
 * ## Transactions
 *
 * One at a time, under `BEGIN IMMEDIATE` held for the whole body: SQLite has
 * one writer, so nothing can change between a transaction's reads and its
 * commit, and a second process on the same file waits (busy_timeout) rather
 * than interleaving. Plain `set`/`delete` queue behind transactions for the
 * same reason. Writes are buffered and applied at the end, so a throw leaves
 * nothing behind, and a read after a write is refused (the port's rule).
 *
 * ONE SqliteStore per database file per process. bun:sqlite is synchronous, so
 * a second connection in the same process would busy-wait for the lock on the
 * event loop that the first transaction needs to finish: a deadlock until
 * busy_timeout. Separate processes are fine; they wait for each other.
 *
 * Uniqueness is still `isUnique`, as on Firestore. The plan's partial unique
 * indexes (the index as the authority) come with registry-driven DDL.
 */
import { Database } from 'bun:sqlite'

import { fieldValue, projectFields, sameValue } from '../../collections/store'
import type {
  QueryOptions,
  Store,
  StoredDoc,
  Tx,
} from '../../collections/store'

export interface SqliteKeys {
  /** Fields usable as `collection/field=value`, matched by equality. */
  unique?: Record<string, string[]>
  /** Fields usable as `collection/field=value`, matched by array-contains. */
  tagFields?: Record<string, string[]>
}

type Row = { collection: string; id: string; data: string }
type Bind = string | number | null

const split = (path: string) => {
  const parts = path.split('/')
  const id = parts.pop() as string
  return { collection: parts.join('/'), id }
}

/** A field path (`meta.title`, as Firestore reads it) as a JSON path, each key quoted. */
const at = (field: string) =>
  '$' +
  field
    .split('.')
    .map((key) => `."${key.replace(/"/g, '\\"')}"`)
    .join('')

const isScalar = (v: unknown) =>
  v === null || ['string', 'number', 'boolean'].includes(typeof v)

/**
 * `value <op> v`, type-checked as Firestore compares: numbers with numbers
 * (integer or real), strings with strings, booleans and null by type. Always
 * uses `typeExpr` then `valueExpr`, once each, so callers bind their
 * placeholders the same way whatever `v` is.
 */
function compare(
  typeExpr: string,
  valueExpr: string,
  op: '=' | '>' | '<',
  v: unknown
): [string, Bind[]] {
  if (v === null || typeof v === 'boolean') {
    // Ranges are same-type only and never used on these; equality is the type.
    const type = v === null ? 'null' : v ? 'true' : 'false'
    return [
      `${typeExpr} = '${type}' AND ${
        op === '=' ? '1' : '0'
      } AND (${valueExpr} IS NULL OR 1)`,
      [],
    ]
  }
  if (typeof v === 'number') {
    return [`${typeExpr} IN ('integer','real') AND ${valueExpr} ${op} ?`, [v]]
  }
  return [`${typeExpr} = 'text' AND ${valueExpr} ${op} ?`, [String(v)]]
}

export class SqliteStore implements Store {
  private readonly db: Database

  constructor(
    /** A file path, ':memory:', or an open Database. */
    db: string | Database = ':memory:',
    private readonly keys: SqliteKeys = {}
  ) {
    this.db = typeof db === 'string' ? new Database(db, { create: true }) : db
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS documents (' +
        'collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, ' +
        'PRIMARY KEY (collection, id)) WITHOUT ROWID'
    )
  }

  close(): void {
    this.db.close()
  }

  // ── reads ──────────────────────────────────────────────────────────────

  private read(path: string): StoredDoc {
    const { collection, id } = split(path)
    const row = this.db
      .query('SELECT data FROM documents WHERE collection = ? AND id = ?')
      .get(collection, id) as { data: string } | null
    return { path, exists: row !== null, data: row ? JSON.parse(row.data) : {} }
  }

  async get(path: string): Promise<StoredDoc> {
    return this.read(path)
  }

  async resolve(path: string): Promise<string | Error> {
    const parts = path.split('/')
    if (parts.length % 2 !== 0) return new Error(`bad path ${path}`)
    const { collection, id } = split(path)
    if (!id.includes('=')) return path
    const [field, value] = id.split('=', 2)
    const tag = (this.keys.tagFields?.[collection] ?? []).includes(field)
    if (!tag && !(this.keys.unique?.[collection] ?? []).includes(field)) {
      return new Error(`${path} is not allowed; ${field} is not an allowed key`)
    }
    // The path's value is a string, compared strictly (Firestore `==` and
    // `array-contains` with a string): `num=5` does not find a stored 5.
    const where = tag
      ? `json_type(data, ?) = 'array' AND EXISTS (SELECT 1 FROM json_each(data, ?) WHERE type = 'text' AND value = ?)`
      : `json_type(data, ?) = 'text' AND json_extract(data, ?) = ?`
    const row = this.db
      .query(
        `SELECT id FROM documents WHERE collection = ? AND ${where} ORDER BY id LIMIT 1`
      )
      .get(collection, at(field), at(field), value) as { id: string } | null
    return row
      ? `${collection}/${row.id}`
      : new Error(`record not found ${path}`)
  }

  async isUnique(
    collection: string,
    field: string,
    value: unknown,
    excludingPath: string
  ): Promise<boolean> {
    // As the Firestore adapter: a non-scalar or absent value never satisfies it.
    if (!['string', 'number'].includes(typeof value)) return false
    const [cond, binds] = compare(
      'json_type(data, ?)',
      'json_extract(data, ?)',
      '=',
      value
    )
    const row = this.db
      .query(
        `SELECT 1 FROM documents WHERE collection = ? AND id != ? AND ${cond} LIMIT 1`
      )
      .get(collection, split(excludingPath).id, at(field), at(field), ...binds)
    return row === null
  }

  async query(
    collection: string,
    options: QueryOptions = {}
  ): Promise<StoredDoc[]> {
    return this.select(collection, options, options.limit)
  }

  private select(
    collection: string,
    options: QueryOptions,
    limit?: number,
    offset = 0
  ): StoredDoc[] {
    const where: string[] = ['collection = ?']
    const binds: Bind[] = [collection]
    const later: Array<(data: Record<string, unknown>) => boolean> = []
    const add = ([cond, b]: [string, Bind[]]) => {
      where.push(cond)
      binds.push(...b)
    }
    const field = (f: string) => {
      binds.push(at(f), at(f))
      return ['json_type(data, ?)', 'json_extract(data, ?)'] as const
    }

    if (options.equals) {
      const { field: f, value } = options.equals
      if (isScalar(value)) {
        const [t, v] = field(f)
        add(compare(t, v, '=', value))
      } else later.push((d) => sameValue(fieldValue(d, f), value))
    }
    if (options.arrayContains) {
      const { field: f, value } = options.arrayContains
      if (isScalar(value)) {
        binds.push(at(f), at(f))
        const [cond, b] = compare('type', 'value', '=', value)
        where.push(
          `json_type(data, ?) = 'array' AND EXISTS (SELECT 1 FROM json_each(data, ?) WHERE ${cond})`
        )
        binds.push(...b)
      } else {
        later.push((d) => {
          const held = fieldValue(d, f)
          return Array.isArray(held) && held.some((h) => sameValue(h, value))
        })
      }
    }
    for (const [range, op] of [
      [options.greaterThan, '>'],
      [options.lessThan, '<'],
    ] as const) {
      if (!range) continue
      const [t, v] = field(range.field)
      add(compare(t, v, op, range.value))
    }
    if (options.oneOf) {
      const { field: f, values } = options.oneOf
      if (values.every(isScalar)) {
        const alternatives = values.map((value) => {
          const [t, v] = field(f)
          const [cond, b] = compare(t, v, '=', value)
          binds.push(...b)
          return `(${cond})`
        })
        where.push(alternatives.length ? `(${alternatives.join(' OR ')})` : '0')
      } else {
later.push((d) => values.some((v) => sameValue(fieldValue(d, f), v)))
}
    }

    // Order: `~` is id order; a field orders by Firestore's type rank, then
    // value, then id, all in the field's direction, and excludes documents
    // that lack the field.
    let order = 'id'
    const [orderField, direction] = (options.orderBy ?? '_created desc').split(
      ' '
    )
    if (orderField !== '~') {
      const dir = direction === 'desc' ? 'DESC' : 'ASC'
      binds.push(at(orderField))
      where.push('json_type(data, ?) IS NOT NULL')
      const t = `json_type(data, '${at(orderField).replace(/'/g, "''")}')`
      const v = `json_extract(data, '${at(orderField).replace(/'/g, "''")}')`
      const rank =
        `CASE ${t} WHEN 'null' THEN 0 WHEN 'false' THEN 1 WHEN 'true' THEN 1 ` +
        `WHEN 'integer' THEN 2 WHEN 'real' THEN 2 WHEN 'text' THEN 3 WHEN 'array' THEN 4 ELSE 5 END`
      order = `${rank} ${dir}, ${v} ${dir}, id ${dir}`
    }

    const paged = later.length === 0 && limit !== undefined
    const sql =
      `SELECT collection, id, data FROM documents WHERE ${where.join(
        ' AND '
      )} ORDER BY ${order}` + (paged ? ' LIMIT ? OFFSET ?' : '')
    if (paged) binds.push(limit, offset)

    let rows = (this.db.query(sql).all(...binds) as Row[]).map((r) => ({
      path: `${r.collection}/${r.id}`,
      exists: true,
      data: JSON.parse(r.data) as Record<string, unknown>,
    }))
    if (!paged) {
      rows = rows.filter((r) => later.every((ok) => ok(r.data)))
      if (limit !== undefined) rows = rows.slice(offset, offset + limit)
    }
    if (options.fields) {
      const keep = options.fields
      rows = rows.map((r) => ({ ...r, data: projectFields(r.data, keep) }))
    }
    return rows
  }

  async* scan(
    collection: string,
    options: Omit<QueryOptions, 'limit'>,
    pageSize: number
  ): AsyncIterable<StoredDoc[]> {
    for (let offset = 0; ; offset += pageSize) {
      const page = this.select(collection, options, pageSize, offset)
      if (page.length === 0) return
      yield page
      if (page.length < pageSize) return
    }
  }

  // ── writes ─────────────────────────────────────────────────────────────

  private write(path: string, data: Record<string, unknown> | null): void {
    const { collection, id } = split(path)
    if (data === null) {
      this.db
        .query('DELETE FROM documents WHERE collection = ? AND id = ?')
        .run(collection, id)
    } else {
      this.db
        .query(
          'INSERT OR REPLACE INTO documents (collection, id, data) VALUES (?, ?, ?)'
        )
        .run(collection, id, JSON.stringify(data))
    }
  }

  /** Transactions and plain writes, one at a time (see the header). */
  private queue: Promise<unknown> = Promise.resolve()

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  set(path: string, data: Record<string, unknown>): Promise<void> {
    return this.serial(async () => this.write(path, data))
  }

  delete(path: string): Promise<void> {
    return this.serial(async () => this.write(path, null))
  }

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const pending: Array<[string, Record<string, unknown>, boolean]> = []
      let writing = false
      const tx: Tx = {
        get: async (path) => {
          if (writing) throw new Error('transaction read after a write')
          return this.read(path)
        },
        query: async (collection, options = {}) => {
          if (writing) throw new Error('transaction read after a write')
          return this.select(collection, options, options.limit)
        },
        set: (path, data, options) => {
          writing = true
          pending.push([
            path,
            JSON.parse(JSON.stringify(data)),
            options?.merge === true,
          ])
        },
      }
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = await fn(tx)
        for (const [path, data, merge] of pending) {
          this.write(path, merge ? { ...this.read(path).data, ...data } : data)
        }
        this.db.exec('COMMIT')
        return result
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
    })
  }
}
