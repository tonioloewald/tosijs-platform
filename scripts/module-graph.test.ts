/**
 * The client's module graph (module-graph.js): the walk itself, and the local
 * build. The deploy check runs the same walk against the deployed site.
 *
 * Run: bun test scripts/module-graph.test.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - a .js module
import { moduleGraph, relativeImports } from './module-graph.js'

type Loaded = { status: number; contentType: string; text: string }
const site =
  (files: Record<string, string | Loaded>) =>
  async (url: string): Promise<Loaded> => {
    const file = files[new URL(url).pathname]
    if (file === undefined)
      return { status: 404, contentType: 'text/html', text: '' }
    return typeof file === 'string'
      ? {
          status: 200,
          contentType: 'text/javascript; charset=utf-8',
          text: file,
        }
      : file
  }

describe('relativeImports', () => {
  test('static imports, re-exports and import(), as bun build writes them', () => {
    const source = `import{a as b}from"./index-4qs.js";export{c}from'./c.js';import"./side.js";const m=()=>import("./code-editor-cm-2y.js");import("https://cdn.jsdelivr.net/npm/x");import(e)`
    expect(relativeImports(source).sort()).toEqual([
      './c.js',
      './code-editor-cm-2y.js',
      './index-4qs.js',
      './side.js',
    ])
  })
})

describe('moduleGraph', () => {
  test('follows chunks, including one that imports the entry back', async () => {
    const { modules, problems } = await moduleGraph(
      'https://site.test/index.js',
      site({
        '/index.js':
          'import{x}from"./shared.js";const e=()=>import("./editor.js")',
        '/shared.js': 'export const x=1',
        '/editor.js': 'import"./index.js";import{x}from"./shared.js"',
      })
    )
    expect(problems).toEqual([])
    expect(modules.map((u: string) => new URL(u).pathname).sort()).toEqual([
      '/editor.js',
      '/index.js',
      '/shared.js',
    ])
  })

  test('a missing chunk, and one answered with HTML, are problems naming who imports them', async () => {
    const { problems } = await moduleGraph(
      'https://site.test/index.js',
      site({
        '/index.js':
          'const e=()=>import("./editor.js");const v=()=>import("./viewer.js")',
        '/viewer.js': {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          text: '<!doctype html>',
        },
      })
    )
    expect(problems).toEqual([
      '/editor.js: 404 (imported by /index.js)',
      '/viewer.js: served as text/html; charset=utf-8, not JavaScript (imported by /index.js)',
    ])
  })

  test('a load that throws is a problem, not a crash', async () => {
    const { problems } = await moduleGraph(
      'https://site.test/index.js',
      async () => {
        throw new Error('connection reset')
      }
    )
    expect(problems).toEqual(['/index.js: connection reset'])
  })
})

// The last `bun run build`; skipped when there is none (dist/ is not tracked).
const DIST = join(import.meta.dir, '..', 'dist')
describe.skipIf(!existsSync(join(DIST, 'index.js')))('the local build', () => {
  test('every module the client can load is in dist/', async () => {
    const { modules, problems } = await moduleGraph(
      'https://build.test/index.js',
      async (url: string) => {
        const file = join(DIST, new URL(url).pathname)
        return existsSync(file)
          ? {
              status: 200,
              contentType: 'text/javascript',
              text: readFileSync(file, 'utf-8'),
            }
          : { status: 404, contentType: '', text: '' }
      }
    )
    expect(problems).toEqual([])
    // The editor is a chunk of its own; if this fails the walk has stopped finding chunks.
    expect(
      modules.some((u: string) => /\/code-editor-cm-[a-z0-9]+\.js$/.test(u))
    ).toBe(true)
  })
})
