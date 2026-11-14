/**
 * Every package the deployed code loads is a production dependency. Cloud
 * Functions installs with NODE_ENV=production, which skips devDependencies, so
 * a package listed only there passes every local test and then fails at
 * startup ("Cannot find module"), and the new revision never serves. That
 * happened with `marked` (#4063): `npm i --save` kept it where it already was,
 * in devDependencies.
 *
 * A static scan of the non-test sources under src/ and shared/ (what tsc
 * compiles into lib/), for `import … from`, `import(…)` and `require(…)`.
 * The Bun host's own adapters are left out: they never deploy, and they
 * import what only Bun provides (`bun:sqlite`, its built-in `ws`).
 */
import { test, expect } from 'bun:test'
import { builtinModules } from 'module'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') ? [p] : []
  })
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
const packageOf = (spec: string) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')

/** Only on the Bun host; nothing deployed imports them. */
const HOST_ONLY = [join(ROOT, 'src/adapters/bun'), join(ROOT, 'src/adapters/sqlite')]

// The test runs under Bun, which counts packages it bundles as built in. Node,
// where the functions run, does not: an import of one of these needs a
// dependency like any other.
const BUN_ONLY_BUILTINS = new Set(['ws', 'undici'])

test('deployed code loads only production dependencies', () => {
  const builtins = new Set(builtinModules.filter((name) => !BUN_ONLY_BUILTINS.has(name)))
  const loaded = new Map<string, string>()
  const deployed = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'shared'))].filter(
    (file) => !HOST_ONLY.some((dir) => file.startsWith(dir + '/'))
  )
  for (const file of deployed) {
    const text = readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    // Type-only imports are erased by tsc and load nothing.
    const specs = [
      ...text.matchAll(/^\s*import\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]/gm),
      ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
      ...text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...text.matchAll(/(?<!typeof\s)\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1])
    for (const spec of specs) {
      if (spec.startsWith('.') || spec.startsWith('node:') || builtins.has(packageOf(spec))) continue
      if (spec.includes(':')) continue // bun:, or a URL inside a page template
      loaded.set(packageOf(spec), file.slice(ROOT.length + 1))
    }
  }
  expect(loaded.size).toBeGreaterThan(5) // the scan found the imports at all
  const missing = [...loaded].filter(([name]) => !pkg.dependencies?.[name]).map(([name, file]) => `${name} (${file})`)
  expect(missing).toEqual([])
})
