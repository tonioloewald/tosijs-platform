/**
 * `<asset-manager>` against a fake `AssetFiles`: it works on what it is given
 * (the files, the folders) and reaches for nothing of the host's.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { assetManager, type AssetManager } from './asset-manager'
import type { Asset, AssetFiles } from './files'

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

const fakeFiles = (folders: Record<string, string[]>) => {
  const calls: string[] = []
  const files: AssetFiles = {
    async list(folder) {
      calls.push(`list ${folder}`)
      return (folders[folder] ?? []).map(
        (name): Asset => ({ name, path: `${folder}/${name}` })
      )
    },
    async upload(body, path) {
      calls.push(`upload ${path} ${body.size}`)
      const folder = path.slice(0, path.indexOf('/'))
      folders[folder] = [
        ...(folders[folder] ?? []),
        path.slice(folder.length + 1),
      ]
      return path
    },
    async remove(path) {
      calls.push(`remove ${path}`)
      return true
    },
    async move(from, to) {
      calls.push(`move ${from} ${to}`)
      return true
    },
    url: (path) => `/files/${path}`,
  }
  return { files, calls }
}

const rows = (el: AssetManager) =>
  Array.from(el.querySelectorAll('[part=assetList] .row .elastic')).map(
    (s) => s.textContent
  )

let mounted: AssetManager | null = null
afterEach(() => {
  mounted?.remove()
  mounted = null
})

const mount = async (props: { files?: AssetFiles; folders?: string[] }) => {
  mounted = assetManager(props) as AssetManager
  document.body.append(mounted)
  await tick()
  return mounted
}

describe('<asset-manager>', () => {
  test('lists the first folder it is given, from the files it is given', async () => {
    const { files, calls } = fakeFiles({
      'blog:public': ['b.png', 'a.pdf'],
      other: ['x'],
    })
    const el = await mount({ files, folders: ['blog:public', 'other'] })
    expect(calls).toEqual(['list blog:public'])
    expect(rows(el)).toEqual(['b.png', 'a.pdf'])
    expect(el.parts.pathSelector.value).toBe('blog:public')
  })

  test('by default it offers the areas the assets manifest installs', async () => {
    const { files, calls } = fakeFiles({})
    await mount({ files })
    expect(calls).toEqual(['list assets:public'])
  })

  test('two asset managers do not share a list or a filter', async () => {
    const a = fakeFiles({ 'assets:public': ['one.png'] })
    const b = fakeFiles({ 'assets:public': ['two.png'] })
    const first = await mount({ files: a.files })
    const second = assetManager({ files: b.files }) as AssetManager
    document.body.append(second)
    await tick()
    second.parts.search.value = 'zzz'
    second.parts.search.dispatchEvent(new Event('input'))
    await tick()
    expect(rows(first)).toEqual(['one.png'])
    expect(rows(second)).toEqual([])
    second.remove()
  })

  test('the filter narrows the list as it is typed', async () => {
    const { files } = fakeFiles({
      'assets:public': ['cat.png', 'dog.png', 'cat.pdf'],
    })
    const el = await mount({ files })
    el.parts.search.value = 'cat'
    el.parts.search.dispatchEvent(new Event('input'))
    await tick()
    expect(rows(el)).toEqual(['cat.png', 'cat.pdf'])
  })

  test('uploads the picked file to the selected folder, then lists it', async () => {
    const { files, calls } = fakeFiles({ 'assets:public': [] })
    const el = await mount({ files })
    const { fileInput, filePath, convertToWebP } = el.parts
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['hello'], 'notes.txt', { type: 'text/plain' })],
    })
    el.setPath()
    expect(filePath.value).toBe('notes.txt')
    expect(convertToWebP.checked).toBe(false) // not an image
    await el.uploadFile()
    await tick()
    expect(calls).toEqual([
      'list assets:public',
      'upload assets:public/notes.txt 5',
      'list assets:public',
    ])
    expect(rows(el)).toEqual(['notes.txt'])
  })

  test('with no files to work on it says so rather than failing silently', async () => {
    const el = await mount({})
    await el.getFiles() // reports, does not throw
    expect(rows(el)).toEqual([])
    const notes = document.querySelector('tosi-notification')?.shadowRoot
    expect(notes?.textContent).toContain('<asset-manager> has no files')
  })
})
