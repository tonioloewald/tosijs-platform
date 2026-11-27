/**
 * Where an asset lives, and what the asset manager needs from whatever stores
 * it. Pure: no DOM, no network.
 *
 * A file's path is `<folder>/<name>`. A folder that is a STORAGE AREA
 * (`blog:public`: a collection name, so it contains `:`, D15/D21) is served by
 * `/blob` under the area's access rules. A host may have other folders too
 * (loewald.com still has a legacy Storage folder, `public`); an `AssetFiles`
 * that knows them can serve them, and `blobFiles` refuses them.
 */

export interface Asset {
  /** The path within its folder. */
  name: string
  /** `<folder>/<name>`. */
  path: string
  /** As stored. Storage areas list it; a host's other folders may not. */
  contentType?: string
}

/** The files the asset manager shows, wherever they live. */
export interface AssetFiles {
  /** The files in a folder, sorted by name. Throws when the folder cannot be listed. */
  list(folder: string): Promise<Asset[]>
  /**
   * Store `body` at `path`. Resolves to the path the file was actually stored
   * at (a storage area cleans names); throws, with the host's reason, when it
   * was not stored.
   */
  upload(body: Blob, path: string): Promise<string>
  /** Whether the file was deleted. */
  remove(path: string): Promise<boolean>
  /** Whether the file was moved (a rename is a move within a folder). */
  move(from: string, to: string): Promise<boolean>
  /** The address a page uses for the file. */
  url(path: string): string
}

export interface FileLocation {
  /** The storage area, or null for a folder that is not one. */
  area: string | null
  folder: string
  /** The path within the folder. */
  name: string
}

export function locate(path: string): FileLocation {
  const clean = path.replace(/^\/+/, '')
  const slash = clean.indexOf('/')
  const folder = slash === -1 ? clean : clean.slice(0, slash)
  const name = slash === -1 ? '' : clean.slice(slash + 1)
  return { area: folder.includes(':') ? folder : null, folder, name }
}

/**
 * A file name `/blob` accepts: letters, digits, `.`, `_`, `-`, starting with a
 * letter or digit. Runs of anything else become one `-`. The same rule as the
 * migration's (`scripts/sandbox-lib.js`; a test holds them together), so a
 * file uploaded today is named as a migrated one was.
 */
export const cleanName = (name: string): string =>
  name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[-.]+$/, '') || 'file'

/** A path within an area, each segment given a clean name. */
export const cleanPath = (name: string): string =>
  name
    .split('/')
    .filter((s) => s !== '')
    .map(cleanName)
    .join('/')

export type FileKind = 'image' | 'video' | 'audio' | 'other'

/**
 * What kind of file this is, for the insert menu. The stored content type
 * decides when there is one: 34 of the files migrated into `blog:public` have
 * no extension (`zod-bundled-on-bundlejs` is a webp), and by extension alone
 * they were offered only links. A folder that lists no content type falls back
 * to the extension (`byExtension`).
 */
export function fileKind(
  contentType: unknown,
  byExtension: FileKind
): FileKind {
  const type = typeof contentType === 'string' ? contentType : ''
  const category = /^([a-z]+)\/\S+$/i.exec(type)?.[1]?.toLowerCase()
  if (category === 'image' || category === 'video' || category === 'audio') {
    return category
  }
  return category ? 'other' : byExtension
}
