import {
  Component,
  ElementCreator,
  PartsMap,
  elements,
  vars,
  varDefault,
  getListItem,
  tosi,
  touch,
  tosiValue,
} from 'tosijs'
import {
  tosiFloat,
  tosiSizer,
  icons,
  postNotification,
  popMenu,
  tosiSelect,
  TosiSelect,
  TosiDialog,
} from 'tosijs-ui'
import type { CodeEditor } from 'tosijs-ui/code-editor'
import { fileKind, type Asset, type AssetFiles } from './files.js'
import { getDimensionsStyleAttr, imageToWebP } from './media.js'
import {
  getExtension,
  getMediaType,
  type MediaType,
} from '../../functions/shared/mime-types.js'

const altText = (fileName: string): string => {
  const [text] = fileName.split('.')
  return text.replace(/[-_]/g, ' ')
}

export const escapeHTMLAttribute = (value: string): string => {
  return value.replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Labels for insert/copy actions based on file type
const INSERT_LABELS: Record<string, { markdown: string; html: string }> = {
  image: { markdown: 'Insert Image', html: 'Insert <img>' },
  video: { markdown: 'Insert Link', html: 'Insert <video>' },
  audio: { markdown: 'Insert Link', html: 'Insert <audio>' },
  other: { markdown: 'Insert Link', html: 'Insert Link' },
}

const COPY_LABELS: Record<string, { markdown: string; html: string }> = {
  image: { markdown: 'Copy Image Markdown', html: 'Copy <img> HTML' },
  video: { markdown: 'Copy Link Markdown', html: 'Copy <video> HTML' },
  audio: { markdown: 'Copy Link Markdown', html: 'Copy <audio> HTML' },
  other: { markdown: 'Copy Link Markdown', html: 'Copy Link HTML' },
}

const { h4, label, input, button, div, span, template } = elements

interface AssetList {
  files: Asset[]
  filter: string
  filteredFiles: Asset[]
}

// Each <asset-manager> has its own list and filter: two on one page, or one
// opened after another, never share them.
let instances = 0
const assetList = () => {
  const key = `assetManager${++instances}`
  const state = tosi({
    [key]: {
      files: [] as Asset[],
      filter: '',
      // Must use `this`, not an outer binding, and must have a setter. tosijs
      // 1.7 Object.assigns over this literal during registration, which
      // evaluates the getter before any outer binding is assigned (throws) and
      // then writes the result back (throws on a getter-only property).
      get filteredFiles(): Asset[] {
        const filter = String(this.filter).toLocaleLowerCase()
        const { files } = this as unknown as { files: Asset[] }
        return filter === ''
          ? files
          : files.filter(
              (asset: Asset) =>
                asset.name.toLocaleLowerCase().includes(filter) ||
                asset.path.toLocaleLowerCase().includes(filter)
            )
      },
      set filteredFiles(_files: Asset[]) {
        /* computed from files + filter; the registration write-back is ignored */
      },
    },
  } as Record<string, AssetList>)
  return state[key]
}

interface AssetManagerParts extends PartsMap {
  search: HTMLInputElement
  fileInput: HTMLInputElement
  pathSelector: TosiSelect
  filePath: HTMLInputElement
  convertToWebP: HTMLInputElement
}

/**
 * `<asset-manager>`: a floating panel that lists, uploads, renames and deletes
 * the files in a host's folders, and inserts a file into an editor (or copies
 * it as Markdown, HTML or a URL).
 *
 * It is told what to work on, and assumes nothing about the host:
 *
 * - `files`: where the files live (`blobFiles(…)` for storage areas, or the
 *   host's own `AssetFiles`).
 * - `folders`: the folders it offers, the first selected. Default: the areas
 *   the assets manifest installs.
 * - `insertInto`: the `<tosi-code>` that Insert writes into, or null (then the
 *   menu copies to the clipboard instead).
 */
export class AssetManager extends Component<AssetManagerParts> {
  static preferredTagName = 'asset-manager'
  static lightStyleSpec = {
    ':host': {
      _spacing: varDefault.pad('10px'),
    },
    ':host tosi-sizer': {
      _resizeIconFill: vars.textColor,
    },
    ':host [part=assetList] .row': {
      padding: 2,
    },
    ':host tosi-select': {
      display: 'inline-flex',
      width: 100,
      _fieldWidth: 40,
      _touchSize: 32,
    },
    ':host tosi-float': {
      background: vars.panelBg,
      display: 'flex',
      flexDirection: 'column',
    },
    ':host .text-nowrap': {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
  }

  private list = assetList()

  files: AssetFiles | null = null
  folders: string[] = ['assets:public', 'assets:private']
  insertInto: () => CodeEditor | null = () => null

  private get store(): AssetFiles {
    if (!this.files)
      throw new Error('<asset-manager> has no files: set its `files`')
    return this.files
  }

  popItemMenu = (event: Event) => {
    const target = event.target as HTMLElement
    const file = getListItem(target)
    const codeEditor = this.insertInto()
    const { getFiles, store } = this
    // Unwrapped: a field read off a list proxy is a boxed object, not a string.
    const record = tosiValue(file) as Asset
    const fileUrl = store.url(record.path)
    const type = fileKind(record.contentType, getMediaType(record.path))

    const labels = codeEditor ? INSERT_LABELS[type] : COPY_LABELS[type]

    // tosijs-ui 1.7 swapped ACE for CodeMirror 6: `editor` is an EditorView,
    // and it's undefined until the editor has mounted.
    const insert = (code: string) => {
      const editor = codeEditor?.editor
      if (editor) {
        editor.dispatch(editor.state.replaceSelection(code))
      } else {
        navigator.clipboard.writeText(code)
      }
    }

    popMenu({
      target,
      menuItems: [
        {
          caption: labels.markdown,
          icon: codeEditor ? 'code' : 'copy',
          async action() {
            // Markdown only has native syntax for images; video/audio use link syntax
            insert(
              type === 'image'
                ? `![${altText(record.name)}](${fileUrl})`
                : `[${altText(record.name)}](${fileUrl})`
            )
          },
        },
        {
          caption: labels.html,
          icon: codeEditor ? 'code' : 'copy',
          async action() {
            let code: string
            const alt = escapeHTMLAttribute(altText(record.name))

            if (type === 'image' || type === 'video') {
              const closeNotification = postNotification({
                type: 'progress',
                message: 'Getting dimensions…',
              })
              const styleAttr = await getDimensionsStyleAttr(
                fileUrl,
                type as MediaType
              )
              closeNotification()
              code =
                type === 'image'
                  ? `<img alt="${alt}" src="${fileUrl}"${styleAttr}>`
                  : `<video controls src="${fileUrl}" title="${alt}"${styleAttr}></video>`
            } else if (type === 'audio') {
              code = `<audio controls src="${fileUrl}" title="${alt}"></audio>`
            } else {
              code = `<a href="${fileUrl}">${altText(record.name)}</a>`
            }
            insert(code)
          },
        },
        {
          caption: 'Copy URL',
          icon: 'link',
          action() {
            navigator.clipboard.writeText(fileUrl)
            postNotification({
              type: 'info',
              message: `url for "${record.name}" copied to clipboard`,
            })
          },
        },
        null,
        {
          caption: 'View',
          icon: 'eye',
          action() {
            window.open(fileUrl)
          },
        },
        null,
        {
          caption: 'Rename',
          icon: 'edit',
          async action() {
            const newName = await TosiDialog.prompt(
              'Filename:',
              'Rename Asset',
              record.name
            )
            if (newName && newName !== record.name) {
              // Check if extension changed
              const oldExt = getExtension(record.name)
              const newExt = getExtension(newName)
              if (oldExt !== newExt) {
                const confirmed = await TosiDialog.confirm(
                  `Changing extension from "${
                    oldExt ? `.${oldExt}` : '(none)'
                  }" to "${
                    newExt ? `.${newExt}` : '(none)'
                  }" may cause the file to be embedded incorrectly. Continue?`
                )
                if (!confirmed) return
              }

              const dir = record.path.substring(0, record.path.lastIndexOf('/'))
              const newPath = `${dir}/${newName}`
              const closeNotification = postNotification({
                type: 'progress',
                message: `Renaming "${record.name}" to "${newName}"…`,
              })
              const success = await store.move(record.path, newPath)
              closeNotification()
              if (success) {
                postNotification({
                  type: 'info',
                  message: `Renamed to "${newName}"`,
                })
              } else {
                postNotification({
                  type: 'error',
                  message: `Failed to rename "${record.name}"`,
                })
              }
              await getFiles()
            }
          },
        },
        {
          caption: 'Delete',
          icon: 'trash',
          async action() {
            if (await TosiDialog.confirm(`Delete "${record.path}"?`)) {
              if (await store.remove(record.path)) {
                postNotification({
                  type: 'info',
                  message: `File ${record.path} has ceased to be. Bereft of life, it rests in peace. It is an ex-file.`,
                })
              } else {
                postNotification({
                  type: 'error',
                  message: `${record.path} was not deleted, or was already deleted by someone else. Who knows…?`,
                })
              }
              await getFiles()
            }
          },
        },
      ],
    })
  }

  uploadFile = async () => {
    const { fileInput, pathSelector, filePath, convertToWebP } = this.parts
    const file = fileInput.files?.length === 1 ? fileInput.files[0] : null
    if (!file) {
      postNotification({ type: 'error', message: 'Pick a file first!' })
      return
    }
    const desiredPath = `${pathSelector.value}/${filePath.value}`
    const closeNotification = postNotification({
      type: 'progress',
      message: `Uploading "${file.name}" to "${desiredPath}"`,
    })
    try {
      const body = convertToWebP.checked ? await imageToWebP(file) : file
      const path = await this.store.upload(body, desiredPath)
      postNotification({
        type: 'info',
        message: `${file.name} uploaded to path '${path}'`,
      })
      // The name the file actually got (an area cleans it).
      this.list.filter.value = path.slice(path.indexOf('/') + 1)
      filePath.value = ''
      fileInput.value = ''
      await this.getFiles()
    } catch (e) {
      postNotification({
        type: 'error',
        message: `${file.name} was not uploaded: ${
          e instanceof Error ? e.message : e
        }`,
      })
    } finally {
      closeNotification()
    }
  }

  setPath = () => {
    const { fileInput, filePath, convertToWebP } = this.parts
    if (fileInput.files?.length === 1) {
      const fileName = fileInput.files[0].name
      filePath.value = fileName.replace(/\s+/g, '-')
      const isImage = getMediaType(fileName) === 'image'
      const ext = getExtension(fileName)
      // Don't convert GIF (loses animation) or SVG (vector format) to webP
      const shouldConvert = isImage && ext !== 'gif' && ext !== 'svg'
      convertToWebP.disabled = !isImage
      convertToWebP.checked = shouldConvert
    } else {
      filePath.value = ''
      convertToWebP.disabled = false
      convertToWebP.checked = true
    }
  }

  getFiles = async () => {
    const { pathSelector } = this.parts
    try {
      this.list.files.value = await this.store.list(pathSelector.value)
      touch(this.list.filteredFiles)
    } catch (e) {
      postNotification({
        type: 'error',
        message: `Error: ${e instanceof Error ? e.message : e}`,
      })
    }
  }

  // On every keystroke, not just on `change` (Return or blur), which a phone's
  // search field rarely fires. Read from the field itself, so the list never
  // waits on the binding to catch up.
  updateList = () => {
    this.list.filter.value = this.parts.search.value
    touch(this.list.filteredFiles)
  }

  content = () =>
    tosiFloat(
      {
        class: 'compact',
        drag: true,
        style: {
          bottom: '10px',
          left: '10px',
          maxWidth: 'calc(100% - 20px)',
          minHeight: '360px',
          minWidth: '360px',
          width: '400px',
          overflow: 'hidden',
        },
      },
      h4('Asset Manager', {
        class: 'primary',
        style: { textAlign: 'center', padding: vars.spacing75, margin: 0 },
      }),
      div(
        { class: 'row no-drag', style: { padding: vars.spacing50 } },
        input({
          part: 'search',
          type: 'search',
          placeholder: 'filter items',
          bindValue: this.list.filter,
          onInput: this.updateList,
          onChange: this.updateList,
        }),
        span({ class: 'elastic' }),
        label(
          {
            class: 'row',
            style: {
              padding: 0,
              justifyContent: 'flex-end',
            },
          },
          span('Path'),
          tosiSelect({
            options: this.folders.join(','),
            value: this.folders[0],
            part: 'pathSelector',
            onChange: this.getFiles,
          })
        )
      ),
      div(
        {
          part: 'assetList',
          class: 'column elastic no-drag',
          style: {
            height: '300px',
            overflow: 'hidden scroll',
            alignItems: 'stretch',
            content: ' ',
            margin: `0 ${vars.spacing50}`,
          },
          bindList: {
            value: this.list.filteredFiles,
            idPath: 'path',
          },
        },
        template(
          div(
            { class: 'row' },
            span({ class: 'text-nowrap elastic', bindText: '^.name' }),
            button(
              {
                title: 'Options',
                onClick: this.popItemMenu,
              },
              icons.moreVertical()
            )
          )
        )
      ),
      div(
        {
          class: 'column no-drag',
          style: {
            alignItems: 'stretch',
            padding: vars.spacing50,
            gap: vars.spacing50,
          },
        },
        label(
          { class: 'row nopad' },
          span('File'),
          input({
            part: 'fileInput',
            type: 'file',
            onChange: this.setPath,
            class: 'elastic',
          })
        ),
        label(
          { class: 'row nopad' },
          span('Path'),
          input({
            placeholder: 'File Name',
            part: 'filePath',
            class: 'elastic',
          })
        ),
        div(
          { class: 'row' },
          label(
            input({ part: 'convertToWebP', checked: true, type: 'checkbox' }),
            span('Convert to webP')
          ),
          span({ class: 'elastic' }),
          button(
            {
              class: 'row',
              style: {
                alignSelf: 'center',
                alignItems: 'center',
                gap: vars.spacing50,
                marginRight: vars.spacing150,
              },
            },
            span('Upload'),
            icons.upload(),
            {
              onClick: this.uploadFile,
            }
          )
        )
      ),
      tosiSizer({ class: 'no-drag' }),
      button(
        {
          title: 'close asset manager',
          class: 'iconic no-drag',
          style: {
            position: 'absolute',
            top: 0,
            right: 0,
          },
          onClick: this.remove.bind(this),
        },
        icons.x()
      )
    )

  connectedCallback() {
    super.connectedCallback()

    this.getFiles()
  }
}

export const assetManager =
  AssetManager.elementCreator() as ElementCreator<AssetManager>
