import { Component as WebComponent, ElementCreator } from 'tosijs'
import { markdownViewer, MarkdownViewer } from 'tosijs-ui'

import { Page, emptyPage } from '../functions/shared/page'

export class XinPage extends WebComponent {
  _page: Page = { ...emptyPage }

  set page(p: Page) {
    this._page = p
    this.queueRender()
  }

  get page(): Page {
    return this._page
  }

  content = null

  constructor() {
    super()
  }

  render() {
    super.render()
    this.textContent = ''

    const { source } = this.page
    if (!source) {
      return
    }

    const isMarkdown =
      source.trimStart().startsWith('#') ||
      source.trimStart().startsWith('---') ||
      !source.trimStart().startsWith('<')

    if (isMarkdown) {
      this.append(markdownViewer({ value: source }))
    } else {
      this.innerHTML = source
    }
  }
}

export const xinPage = XinPage.elementCreator({
  tag: 'xin-page',
}) as ElementCreator<XinPage>
