/**
 * The Files port (files.ts) on a directory: a single-box host's bytes are
 * plain files under `root`, at their keys, so `blog/spaceship.webp` is
 * `<root>/blog/spaceship.webp`. Each object's content type sits beside it in
 * `<root>/.meta/<key>.json`.
 *
 * Keys are refused if they could leave `root` or reach `.meta` (an absolute
 * path, `..`, an empty or dot-led segment, a NUL). Writes land in a temporary
 * file renamed into place, so a reader never sees half an object.
 *
 * Nothing is signed: `url` is null and `signedReadUrl` rejects, so /blob and
 * /stored stream the bytes, with the same access checks and headers.
 */
import { createHash, randomBytes } from 'crypto'
import { createReadStream } from 'fs'
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'fs/promises'
import { dirname, join } from 'path'
import { Readable } from 'stream'
import type { FilesProvider } from '../../files'

const META = '.meta'

export function directoryFiles(root: string): FilesProvider {
  const pathOf = (key: string, under = ''): string => {
    const segments = key.split('/')
    if (
      key.includes('\0') ||
      segments.some((s) => s === '' || s.startsWith('.'))
    ) {
      throw new Error(`refused file key: ${JSON.stringify(key)}`)
    }
    return join(root, under, ...segments)
  }
  const metaOf = (key: string) => `${pathOf(key, META)}.json`

  const atomically = async (path: string, bytes: Uint8Array | string) => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, path)
  }
  const head = async (key: string) => {
    try {
      const info = await stat(pathOf(key))
      if (!info.isFile()) return null
      let contentType = 'application/octet-stream'
      try {
        contentType =
          JSON.parse(await readFile(metaOf(key), 'utf8')).contentType ??
          contentType
      } catch {
        // no recorded type: a file copied in by hand
      }
      return { bytes: info.size, contentType }
    } catch {
      return null
    }
  }
  // A refused key is an erroring stream, like a missing one, never a throw.
  const read = (key: string): NodeJS.ReadableStream => {
    try {
      return createReadStream(pathOf(key))
    } catch (e) {
      return new Readable({
        read() {
          this.destroy(e as Error)
        },
      })
    }
  }

  return {
    objects: {
      put: async (key, bytes, contentType) => {
        await atomically(pathOf(key), bytes)
        await atomically(metaOf(key), JSON.stringify({ contentType }))
      },
      delete: async (key) => {
        await rm(pathOf(key), { force: true })
        await rm(metaOf(key), { force: true })
      },
      copy: async (from, to) => {
        const found = await head(from)
        if (!found) throw new Error(`no such file: ${from}`)
        await mkdir(dirname(pathOf(to)), { recursive: true })
        await copyFile(pathOf(from), pathOf(to))
        await atomically(
          metaOf(to),
          JSON.stringify({ contentType: found.contentType })
        )
      },
      head,
      hash: (key) =>
        new Promise<string>((resolve, reject) => {
          const h = createHash('sha256')
          read(key)
            .on('error', reject)
            .on('data', (chunk) => h.update(chunk))
            .on('end', () => resolve(h.digest('hex')))
        }),
      url: async () => null,
      read,
    },
    legacy: {
      exists: async (key) => (await head(key)) !== null,
      signedReadUrl: async () => {
        throw new Error('a directory cannot sign URLs')
      },
      contentType: async (key) => {
        const found = await head(key)
        return found && found.contentType !== 'application/octet-stream'
          ? found.contentType
          : undefined
      },
      read,
    },
  }
}
