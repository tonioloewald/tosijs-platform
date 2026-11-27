/**
 * Moving the blog's posts and pages from the platform's bare `post` and `page`
 * to the blog manifest's `blog:post` and `blog:page` (D28).
 *
 * Pure: the plan, and the one rewrite a document needs. The I/O is in
 * migrate-blog-collections.js (a live host) and clone-to-sandbox.js (a backup).
 * Documents are Firestore REST `fields` and copied as they are, so no value
 * goes through a decode and re-encode that could change its type.
 */

export const MOVES = [
  { from: 'post', to: 'blog:post' },
  { from: 'page', to: 'blog:page' },
]
const RENAMED = Object.fromEntries(MOVES.map((m) => [m.from, m.to]))

/** A document path naming a moved collection, renamed: `post/path=[3]` → `blog:post/path=[3]`. */
export function movedPath(path) {
  if (typeof path !== 'string') return path
  const [first, ...rest] = path.split('/')
  return RENAMED[first] ? [RENAMED[first], ...rest].join('/') : path
}

/**
 * A page's fields with its `prefetch` patterns renamed. A page names the
 * documents it needs (`prefetch: [{ regexp, path }]`): production's blog page
 * names `post/path=[3]`, which after the move names nothing, so every post URL
 * would render without its post. Anything else is returned untouched (the same
 * object when nothing changes).
 */
export function movedPageFields(fields) {
  const values = fields?.prefetch?.arrayValue?.values
  if (!Array.isArray(values)) return fields
  let changed = false
  const renamed = values.map((v) => {
    const path = v?.mapValue?.fields?.path?.stringValue
    const next = movedPath(path)
    if (next === path) return v
    changed = true
    return {
      ...v,
      mapValue: { ...v.mapValue, fields: { ...v.mapValue.fields, path: { stringValue: next } } },
    }
  })
  return changed ? { ...fields, prefetch: { arrayValue: { ...fields.prefetch.arrayValue, values: renamed } } } : fields
}

/** The same rewrite on a decoded page (a backup's `data`), for clone-to-sandbox.js. */
export function movedPageData(data) {
  if (!Array.isArray(data?.prefetch)) return data
  const prefetch = data.prefetch.map((p) => (p && movedPath(p.path) !== p.path ? { ...p, path: movedPath(p.path) } : p))
  return prefetch.some((p, i) => p !== data.prefetch[i]) ? { ...data, prefetch } : data
}

/** The rewrite for documents of a moved collection. */
export const transformFor = (from) => (from === 'page' ? movedPageFields : (fields) => fields)

/** Key-sorted JSON, so two documents compare by content, not key order. */
export const stable = (v) =>
  v && typeof v === 'object'
    ? Array.isArray(v)
      ? `[${v.map(stable).join(',')}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
          .join(',')}}`
    : JSON.stringify(v)

const modified = (fields) => fields?._modified?.stringValue ?? fields?._modified?.timestampValue ?? ''

/**
 * What to do with each document. `source` and `target` map a document id to
 * `{ fields, updateTime }`.
 *
 *   create        not in the target yet
 *   update        in the target but different, and the SOURCE was modified
 *                 later: it changed after an earlier run copied it
 *   kept          in the target but different, and the TARGET was modified
 *                 later: edited after the move, so the target wins
 *   conflict      different, and neither is later; left alone and reported
 *   unchanged     already identical
 *   onlyInTarget  written after the move; left alone
 *
 * Nothing is ever planned for deletion: the old collections stay, as the
 * rollback, until someone removes them deliberately.
 */
export function planMove(source, target, transform = (fields) => fields) {
  const plan = { create: [], update: [], kept: [], conflict: [], unchanged: [], onlyInTarget: [] }
  for (const [id, src] of source) {
    const want = transform(src.fields)
    const have = target.get(id)
    if (!have) {
      plan.create.push({ id, fields: want })
      continue
    }
    if (stable(have.fields) === stable(want)) {
      plan.unchanged.push(id)
      continue
    }
    const a = modified(want)
    const b = modified(have.fields)
    if (b > a) plan.kept.push(id)
    else if (a > b) plan.update.push({ id, fields: want, updateTime: have.updateTime })
    else plan.conflict.push(id)
  }
  for (const id of target.keys()) if (!source.has(id)) plan.onlyInTarget.push(id)
  return plan
}

/** Done when every source document is in the target, as copied or edited since. */
export const planIsComplete = (plan) => !plan.create.length && !plan.update.length && !plan.conflict.length

/** Is `version` at least `floor`? Plain `x.y.z` only. */
export function atLeast(version, floor) {
  const parse = (v) => String(v ?? '').split('.').map((n) => Number(n))
  const [a, b] = [parse(version), parse(floor)]
  if (a.length !== 3 || a.some((n) => !Number.isInteger(n))) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}
