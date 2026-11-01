/**
 * The Files port (files.ts) on Cloud Storage: `blob-handler.ts`'s
 * `ObjectStore`, moved out of `blob-endpoint.ts` unchanged.
 *
 * The first file under `adapters/` — the one directory the vendor ratchet
 * (vendor-imports.test.ts) lets import a vendor SDK. A sovereign host swaps
 * this for a filesystem or S3-compatible store and nothing above it changes.
 */
import { firebaseAdmin } from './app'
import { createHash } from 'crypto'
import { log } from '../../log'
import type { FilesProvider, LegacyStoredFiles, StreamingObjectStore } from '../../files'

export function cloudStorageObjects(deps: {
  /** Told once per instance that URLs cannot be signed (the handler then streams). */
  onCannotSign: (error: unknown) => void
}): StreamingObjectStore {
  const bucket = () => firebaseAdmin().storage().bucket()
  let signingWarned = false
  return {
    put: async (key, bytes, contentType) => {
      await bucket().file(key).save(Buffer.from(bytes), { contentType, resumable: false })
    },
    delete: async (key) => {
      await bucket().file(key).delete({ ignoreNotFound: true })
    },
    copy: async (from, to) => {
      await bucket().file(from).copy(bucket().file(to))
    },
    head: async (key) => {
      const file = bucket().file(key)
      const [exists] = await file.exists()
      if (!exists) return null
      const [meta] = await file.getMetadata()
      return { bytes: Number(meta.size ?? 0), contentType: String(meta.contentType ?? 'application/octet-stream') }
    },
    hash: (key) =>
      new Promise<string>((resolve, reject) => {
        const h = createHash('sha256')
        bucket()
          .file(key)
          .createReadStream()
          .on('error', reject)
          .on('data', (chunk) => h.update(chunk))
          .on('end', () => resolve(h.digest('hex')))
      }),
    url: async (key, ttlSeconds, contentType) => {
      try {
        const [url] = await bucket()
          .file(key)
          .getSignedUrl({ action: 'read', expires: Date.now() + ttlSeconds * 1000, responseType: contentType })
        return url
      } catch (e) {
        // No signing here — the emulator, or a service account without
        // iam.serviceAccounts.signBlob ("Service Account Token Creator" on
        // itself). The handler then STREAMS the bytes, which is correct (same
        // access check, same cache policy), just proxied through the function.
        // Reported once per instance, never silent (0.2.x ceremony finding).
        if (!signingWarned) {
          signingWarned = true
          deps.onCannotSign(e)
        }
        return null
      }
    },
    read: (key) => bucket().file(key).createReadStream(),
  }
}

/** `/stored`'s legacy reader on the default bucket: v4 signed read URLs, without a response type. */
export function cloudStorageLegacyFiles(): LegacyStoredFiles {
  // The project's DEFAULT bucket — the one the client SDK uploads to and
  // /blob writes to. It was hardcoded as `<project>.appspot.com`, which is
  // wrong for newer projects (`.firebasestorage.app`).
  const file = (key: string) => firebaseAdmin().storage().bucket().file(key)
  return {
    exists: async (key) => (await file(key).exists())[0],
    signedReadUrl: async (key, ttlMs) =>
      (await file(key).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + ttlMs }))[0],
    contentType: async (key) => (await file(key).getMetadata())[0].contentType as string | undefined,
    read: (key) => file(key).createReadStream(),
  }
}

/** Cloud Storage as the host's files (files.ts), installed by index.ts. */
export const firebaseFiles: FilesProvider = {
  objects: cloudStorageObjects({
    onCannotSign: (e) =>
      log.warn(
        'blob: cannot sign URLs — streaming files through the function instead. ' +
          'Grant the functions service account "Service Account Token Creator" on itself to enable redirects.',
        e
      ),
  }),
  legacy: cloudStorageLegacyFiles(),
}
