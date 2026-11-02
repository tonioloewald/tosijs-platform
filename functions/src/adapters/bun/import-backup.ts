/**
 * Load a `bun run backup` snapshot into a local host's data directory, so
 * `bun run serve:local` serves that site (SOVEREIGN-PLAN.md Phase 2 exit).
 *
 *   bun run import:local -- <snapshot dir> [--data .local]
 *
 * - Documents: `<snapshot>/<collection>/<id>.json` (`{_id, _collection, data}`)
 *   into `<data>/host.db`, tagged values decoded as restore-firestore.js does
 *   (a Firestore timestamp becomes its ISO string).
 * - Files: `<snapshot>/storage.json` lists the bucket's objects by md5; the
 *   bytes live in the backup root's shared `storage/objects/<md5[0:2]>/<md5>`.
 *   Each is checked against its md5 and written to `<data>/files/<name>`.
 *
 * A console-made folder marker (`blog/`) is not a file and is skipped; a name
 * the directory refuses (files.ts) is skipped and reported.
 *
 * Refuses a data directory that already holds a database: an import never
 * merges into, or overwrites, a host's data. Refuses a partial snapshot.
 * Reads the backup; never writes to it.
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { SqliteStore } from '../sqlite/store'
import { directoryFiles } from '../local/files'

export interface ImportResult {
  documents: Record<string, number>
  files: number
  missingFiles: string[]
  /** Names a directory cannot hold (files.ts refuses them), skipped. */
  refusedFiles: string[]
  /** False when the snapshot has no storage.json (`bun run backup` alone takes none). */
  hadFiles: boolean
}

/** Invert the backup's tagged encoding (restore-firestore.js `decode`). */
export function decode(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decode)
  const tagged = value as { __type?: unknown; value?: unknown }
  if (typeof tagged.__type === 'string') {
    if (['timestamp', 'bytes', 'reference', 'geopoint'].includes(tagged.__type)) return tagged.value
    throw new Error(`unknown tagged type ${tagged.__type}`)
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = decode(v)
  return out
}

/** Import, or leave the data directory as it was: a failed import is cleaned up, so it can be re-run. */
export async function importSnapshot(options: {
  snapshot: string
  dataDir: string
  objectsDir?: string
}): Promise<ImportResult> {
  const dbFile = join(options.dataDir, 'host.db')
  const filesDir = join(options.dataDir, 'files')
  const hadFiles = existsSync(filesDir)
  try {
    return await importInto(options)
  } catch (e) {
    if (!existsSync(dbFile) || (e as Error).message.includes('empty data directory')) throw e
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) rmSync(f, { force: true })
    if (!hadFiles) rmSync(filesDir, { recursive: true, force: true })
    throw e
  }
}

async function importInto(options: {
  snapshot: string
  dataDir: string
  /** The shared object store; default `<snapshot>/../storage/objects`. */
  objectsDir?: string
}): Promise<ImportResult> {
  const { snapshot, dataDir } = options
  const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8')) as {
    complete?: boolean
    collections?: Array<{ name: string; count: number }>
  }
  if (manifest.complete === false) throw new Error(`${snapshot} is a partial snapshot`)
  const dbFile = join(dataDir, 'host.db')
  if (existsSync(dbFile)) throw new Error(`${dbFile} exists: import into an empty data directory`)

  mkdirSync(dataDir, { recursive: true })
  const store = new SqliteStore(dbFile)
  const documents: Record<string, number> = {}
  try {
    for (const { name } of manifest.collections ?? []) {
      const dir = join(snapshot, name.replace(/[/\\]/g, '_'))
      const docs = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as { _id: string; _collection: string; data: unknown })
      // One transaction per collection: one lock, one fsync.
      await store.transaction(async (tx) => {
        for (const doc of docs) tx.set(`${doc._collection}/${doc._id}`, decode(doc.data) as Record<string, unknown>)
      })
      documents[name] = docs.length
    }
  } finally {
    store.close()
  }

  const result: ImportResult = { documents, files: 0, missingFiles: [], refusedFiles: [], hadFiles: false }
  const storageManifest = join(snapshot, 'storage.json')
  if (!existsSync(storageManifest)) return result
  result.hadFiles = true
  const objectsDir = options.objectsDir ?? join(snapshot, '..', 'storage', 'objects')
  const files = directoryFiles(join(dataDir, 'files'))
  const { objects } = JSON.parse(readFileSync(storageManifest, 'utf8')) as {
    objects: Array<{ name: string; md5: string; contentType?: string }>
  }
  for (const object of objects) {
    // A console-made "folder" is a zero-byte object named `dir/`: not a file.
    if (object.name.endsWith('/')) continue
    const blob = join(objectsDir, object.md5.slice(0, 2), object.md5)
    if (!existsSync(blob) || !statSync(blob).isFile()) {
      result.missingFiles.push(object.name)
      continue
    }
    const bytes = readFileSync(blob)
    if (createHash('md5').update(bytes).digest('hex') !== object.md5) {
      throw new Error(`${blob} does not match its md5: the backup is damaged`)
    }
    try {
      await files.objects.put(object.name, bytes, object.contentType ?? 'application/octet-stream')
      result.files++
    } catch (e) {
      if (!String(e).includes('refused file key')) throw e
      result.refusedFiles.push(object.name)
    }
  }
  return result
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--data')
  const snapshot = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--data')
  if (!snapshot) {
    console.error('usage: bun run import:local -- <snapshot dir> [--data .local]')
    process.exit(1)
  }
  const dataDir = resolve(at >= 0 ? args[at + 1] : join(import.meta.dir, '../../../../.local'))
  importSnapshot({ snapshot: resolve(snapshot), dataDir }).then(
    (r) => {
      for (const [name, n] of Object.entries(r.documents)) console.log(`  ${name.padEnd(20)} ${n}`)
      if (r.hadFiles) console.log(`  files                ${r.files}`)
      else console.warn('  files                NONE: this snapshot has no storage.json (run `bun run backup:storage` too)')
      if (r.missingFiles.length) console.warn(`  MISSING from the object store: ${r.missingFiles.join(', ')}`)
      if (r.refusedFiles.length) console.warn(`  skipped, not a safe file name: ${r.refusedFiles.join(', ')}`)
      console.log(`imported into ${dataDir}`)
    },
    (e) => {
      console.error(String(e instanceof Error ? e.message : e))
      process.exit(1)
    }
  )
}
