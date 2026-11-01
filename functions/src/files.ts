/**
 * The Files port's composition point (SOVEREIGN-PLAN.md Phase 2), installed
 * like the datastore (datastore.ts): index.ts installs Cloud Storage, the Bun
 * server installs a directory. `/blob` and `/stored` reach bytes only through
 * `files`.
 *
 * Until a provider is installed every call REJECTS (or a read stream errors),
 * so an unconfigured host fails closed.
 */
import { Readable } from 'stream'
import type { ObjectStore } from './blob-handler'

export interface StreamingObjectStore extends ObjectStore {
  /** The object's bytes as a stream, for serving from this origin. Errors on a missing key. */
  read(key: string): NodeJS.ReadableStream
}

/**
 * What `/stored` (the LEGACY reader, stored.ts) needs from the default bucket:
 * signed read URLs without a response type, or the bytes to stream.
 */
export interface LegacyStoredFiles {
  exists(key: string): Promise<boolean>
  /** Rejects where URLs cannot be signed (the emulator, a directory); the caller then streams. */
  signedReadUrl(key: string, ttlMs: number): Promise<string>
  /** The stored content type, if the object has one. */
  contentType(key: string): Promise<string | undefined>
  read(key: string): NodeJS.ReadableStream
}

export interface FilesProvider {
  /** Storage areas' bytes (/blob). */
  objects: StreamingObjectStore
  /** The legacy folders (/stored). Same bucket or directory as `objects`. */
  legacy: LegacyStoredFiles
}

const refuse = async (): Promise<never> => {
  throw new Error('no files provider is installed')
}
const failingStream = (): NodeJS.ReadableStream =>
  new Readable({
    read() {
      this.destroy(new Error('no files provider is installed'))
    },
  })

const UNCONFIGURED: FilesProvider = {
  objects: {
    put: refuse,
    delete: refuse,
    copy: refuse,
    head: refuse,
    hash: refuse,
    url: refuse,
    read: failingStream,
  },
  legacy: {
    exists: refuse,
    signedReadUrl: refuse,
    contentType: refuse,
    read: failingStream,
  },
}

let provider: FilesProvider = UNCONFIGURED

/** Install the host's files; returns the one it replaced (tests restore it). */
export function setFilesProvider(p: FilesProvider | null): FilesProvider {
  const previous = provider
  provider = p ?? UNCONFIGURED
  return previous
}

/** The installed files, forwarded at call time (modules capture these at load). */
export const files: FilesProvider = {
  objects: {
    put: (key, bytes, contentType) =>
      provider.objects.put(key, bytes, contentType),
    delete: (key) => provider.objects.delete(key),
    copy: (from, to) => provider.objects.copy(from, to),
    head: (key) => provider.objects.head(key),
    hash: (key) => provider.objects.hash(key),
    url: (key, ttlSeconds, contentType) =>
      provider.objects.url(key, ttlSeconds, contentType),
    read: (key) => provider.objects.read(key),
  },
  legacy: {
    exists: (key) => provider.legacy.exists(key),
    signedReadUrl: (key, ttlMs) => provider.legacy.signedReadUrl(key, ttlMs),
    contentType: (key) => provider.legacy.contentType(key),
    read: (key) => provider.legacy.read(key),
  },
}
