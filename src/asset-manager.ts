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
} from 'tosijs'
import {
  xinFloat,
  xinSizer,
  icons,
  postNotification,
  popMenu,
  CodeEditor,
  xinSelect,
  XinSelect,
  TosiDialog,
} from 'tosijs-ui'
import {
  uploadFile,
  listFiles,
  pathToStoredUrl,
  deleteFile,
  renameFile,
} from './firebase'
import { getDimensionsStyleAttr } from './dimensions'
import {
  getExtension,
  getMediaType,
  MediaType,
} from '../functions/shared/mime-types'

const altText = (fileName: string): string => {
  let [text] = fileName.split('.')
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

export interface Asset {
  name: string
  path: string
}

const { assetManagerData } = tosi({
  assetManagerData: {
    files: [] as Asset[],
    filter: '',
    get filteredFiles(): Asset[] {
      const filter = assetManagerData.filter.toLocaleLowerCase()
      const { files } = assetManagerData as unknown as { files: Asset[] }
      return filter === ''
        ? files
        : files.filter(
            (asset: Asset) =>
              asset.name.toLocaleLowerCase().includes(filter) ||
              asset.path.toLocaleLowerCase().includes(filter)
          )
    },
  },
})

interface AssetManagerParts extends PartsMap {
  search: HTMLInputElement
  fileInput: HTMLInputElement
  pathSelector: XinSelect
  filePath: HTMLInputElement
  convertToWebP: HTMLInputElement
}

class AssetManager extends Component<AssetManagerParts> {
  popItemMenu = (event: Event) => {
    const target = event.target as HTMLElement
    const file = getListItem(target)
    const codeEditor = document.querySelector(
      'xin-post-editor xin-code'
    ) as CodeEditor | null
    const { getFiles } = this
    const storedUrl = pathToStoredUrl(file.path)
    const type = getMediaType(file.path)

    const labels = codeEditor ? INSERT_LABELS[type] : COPY_LABELS[type]

    popMenu({
      target,
      menuItems: [
        {
          caption: labels.markdown,
          icon: codeEditor ? 'code' : 'copy',
          async action() {
            // Markdown only has native syntax for images; video/audio use link syntax
            const code =
              type === 'image'
                ? `![${altText(file.name)}](${storedUrl})`
                : `[${altText(file.name)}](${storedUrl})`
            if (codeEditor) {
              const { editor } = codeEditor
              editor.session.insert(editor.getCursorPosition(), code)
            } else {
              navigator.clipboard.writeText(code)
            }
          },
        },
        {
          caption: labels.html,
          icon: codeEditor ? 'code' : 'copy',
          async action() {
            let code: string
            const alt = escapeHTMLAttribute(altText(file.name))

            if (type === 'image' || type === 'video') {
              const closeNotification = postNotification({
                type: 'progress',
                message: 'Getting dimensions…',
              })
              const styleAttr = await getDimensionsStyleAttr(
                storedUrl,
                type as MediaType
              )
              closeNotification()
              code =
                type === 'image'
                  ? `<img alt="${alt}" src="${storedUrl}"${styleAttr}>`
                  : `<video controls src="${storedUrl}" title="${alt}"${styleAttr}></video>`
            } else if (type === 'audio') {
              code = `<audio controls src="${storedUrl}" title="${alt}"></audio>`
            } else {
              code = `<a href="${storedUrl}">${altText(file.name)}</a>`
            }

            if (codeEditor) {
              const { editor } = codeEditor
              editor.session.insert(editor.getCursorPosition(), code)
            } else {
              navigator.clipboard.writeText(code)
            }
          },
        },
        {
          caption: 'Copy URL',
          icon: 'link',
          action() {
            navigator.clipboard.writeText(storedUrl)
            postNotification({
              type: 'info',
              message: `url for "${file.name}" copied to clipboard`,
            })
          },
        },
        null,
        {
          caption: 'View',
          icon: 'eye',
          action() {
            window.open(storedUrl)
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
              file.name
            )
            if (newName && newName !== file.name) {
              // Check if extension changed
              const oldExt = getExtension(file.name)
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

              const dir = file.path.substring(0, file.path.lastIndexOf('/'))
              const newPath = `${dir}/${newName}`
              const closeNotification = postNotification({
                type: 'progress',
                message: `Renaming "${file.name}" to "${newName}"…`,
              })
              const success = await renameFile(file.path, newPath)
              closeNotification()
              if (success) {
                postNotification({
                  type: 'info',
                  message: `Renamed to "${newName}"`,
                })
              } else {
                postNotification({
                  type: 'error',
                  message: `Failed to rename "${file.name}"`,
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
            if (await TosiDialog.confirm(`Delete "${file.path}"?`)) {
              if (await deleteFile(file.path)) {
                postNotification({
                  type: 'info',
                  message: `File ${file.path} has ceased to be. Bereft of life, it rests in peace. It is an ex-file.`,
                })
              } else {
                postNotification({
                  type: 'error',
                  message: `${file.path} was not deleted, or was already deleted by someone else. Who knows…?`,
                })
              }
              await getFiles()
            }
          },
        },
      ],
    })
  }

  uploadFile = () => {
    const { fileInput, pathSelector, filePath, convertToWebP } = this.parts
    const basePath = pathSelector.value
    if (fileInput.files?.length === 1) {
      const file = fileInput.files[0]
      uploadFile(
        file,
        `/${basePath}/${filePath.value}`,
        convertToWebP.checked
      ).then((path: string) => {
        postNotification({
          type: 'info',
          message: `${file.name} uploaded to path '${path}'`,
        })
        assetManagerData.filter.xinValue = filePath.value
        filePath.value = ''
        fileInput.value = ''
        this.getFiles()
      })
    } else {
      postNotification({
        type: 'error',
        message: 'Pick a file first!',
      })
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
      assetManagerData.files.xinValue = await listFiles(pathSelector.value)
      touch(assetManagerData.filteredFiles)
    } catch (e) {
      postNotification({
        type: 'error',
        message: `Error: ${e}`,
      })
    }
  }

  updateList = () => {
    touch(assetManagerData.filteredFiles)
  }

  content = () =>
    xinFloat(
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
          bindValue: assetManagerData.filter,
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
          xinSelect({
            options: 'blog,public',
            value: 'blog',
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
            value: assetManagerData.filteredFiles,
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
      xinSizer({ class: 'no-drag' }),
      button(
        {
          title: 'close asset manager',
          target: 'asset-manager',
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

export const assetManager = AssetManager.elementCreator({
  tag: 'asset-manager',
  styleSpec: {
    ':host': {
      _spacing: varDefault.pad('10px'),
    },
    ':host xin-sizer': {
      _resizeIconFill: vars.textColor,
    },
    ':host [part=assetList] .row': {
      padding: 2,
    },
    ':host xin-select': {
      display: 'inline-flex',
      width: 100,
      _fieldWidth: 40,
      _touchSize: 32,
    },
    ':host xin-float': {
      background: vars.panelBg,
      display: 'flex',
      flexDirection: 'column',
    },
    ':host .text-nowrap': {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
  },
}) as ElementCreator<AssetManager>
