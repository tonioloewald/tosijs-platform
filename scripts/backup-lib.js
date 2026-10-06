/**
 * Which Firestore collections a backup takes — pure, shared by the backup and
 * the off-site archive.
 *
 * The backup used to name five collections. Everything added since (storage
 * areas' file metadata, installed manifests, the registry the host's rules are
 * served from, grants, tokens) was silently left out: the summary could only
 * show a zero for a collection somebody remembered to list. So the list is now
 * DISCOVERED from the database, and what is left out is the short, explicit
 * list below. A collection nobody has heard of yet is backed up by default.
 */

/**
 * Left out because losing them loses nothing: caches the host rebuilds, and
 * short-lived requests that are useless (or expired) by the time of a restore.
 * A trailing `*` matches a prefix.
 */
export const NOT_BACKED_UP = {
  'cached-record': 'read cache; rebuilt on demand',
  'system:render-*': 'render-on-store cache and its invalidation log; rebuilt on demand (D23)',
  'system:authorize': 'agent authorization requests; minutes-long, single-use',
  'system:install-proposal': 'install proposals; minutes-long, single-use',
}

/**
 * Backed up locally but kept OUT of the off-site archive unless asked
 * (`archive-backup.js --include-roles`): contact details and credentials.
 * Whoever holds the cloud project can re-establish all three directly.
 */
export const LOCAL_ONLY = {
  role: 'contact details (email, phone, mailing address)',
  token: 'agent token hashes and who holds them',
  'system:claim': 'the host claim nonce',
}

const matches = (pattern, name) =>
  pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern

/** Why a collection is not backed up, or null if it is. */
export const exclusionReason = (name) => {
  for (const [pattern, why] of Object.entries(NOT_BACKED_UP)) {
    if (matches(pattern, name)) return why
  }
  return null
}

/** Split the collections a database has into what to back up and what to skip. */
export function selectCollections(ids) {
  const backup = []
  const excluded = []
  for (const name of [...ids].sort()) {
    const why = exclusionReason(name)
    if (why) excluded.push({ name, why })
    else backup.push(name)
  }
  return { backup, excluded }
}

/**
 * A directory name for a collection. Collection ids may contain `:` (fine on
 * disk) but also `/`-free oddities; `.` and `..` and anything with a path
 * separator must never become a path.
 */
export const collectionDir = (name) =>
  name === '.' || name === '..' ? `_${name}` : name.replace(/[/\\]/g, '_')
