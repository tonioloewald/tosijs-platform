/**
 * Where the asset manager's files live (board #2486, blob step 4) — pure.
 *
 * A file location is `<folder>/<name>`. A folder that is a STORAGE AREA
 * (`blog:public`: a collection name, so it contains `:`) is served by `/blob`,
 * under the area's access rules. Any other folder (`public`) is a legacy
 * folder: still read through `/stored` and written by the Storage SDK until it
 * is migrated too.
 */

export interface FileLocation {
  /** The storage area, or null for a legacy folder. */
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

/** The site-relative address of a file: what goes into a post. */
export function fileUrl(path: string): string {
  const { area, folder, name } = locate(path)
  return area ? `/blob/${area}/${name}` : `/stored/${folder}/${name}`
}
