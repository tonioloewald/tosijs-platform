import {
  tosi,
  Component,
  elements,
  vars,
  varDefault,
  bindings,
  getListItem,
  xinValue,
  PartsMap,
} from 'tosijs'
import {
  markdownViewer,
  sideNav,
  SideNav,
  postNotification,
  tabSelector,
  codeEditor,
  CodeEditor,
  icons,
  popMenu,
  LiveExample,
  MarkdownViewer,
  TabSelector,
  makeSorter,
  xinSegmented,
} from 'tosijs-ui'

import * as tosijs from 'tosijs'
import * as tosijsui from 'tosijs-ui'
import { service, ServiceRequestType } from './firebase'
import { getPrefetchedDoc } from './prefetched'
import { app } from './app'
import { randomID } from './random-id'
import { assetManager } from './asset-manager'

export interface BlogRef {
  _path?: string
  title: string
  path: ''
  date?: string
  keywords?: string[]
  summary: string
}

const recentFirst = makeSorter(
  (ref: { date?: any }) => [ref.date || ''],
  [false]
)

// Turndown for HTML→Markdown conversion (bundled, not CDN)
import TurndownService from 'turndown'

let turndownService: TurndownService | null = null

function getTurndownService(): TurndownService {
  if (turndownService) return turndownService

  turndownService = new TurndownService({ headingStyle: 'atx' })
  turndownService.addRule('keep', {
    filter: ['img'],
    replacement(_content: string, node: Node) {
      return (node as Element).outerHTML
    },
  })
  return turndownService
}

function htmlToMarkdown(html: string): string {
  const service = getTurndownService()
  return service.turndown(html)
}

export interface BlogPost extends BlogRef {
  content: string
  format?: 'markdown' | 'html'
  author: string
}

const emptyPost: BlogPost = {
  title: '',
  path: '',
  content: '',
  format: 'markdown',
  date: '',
  keywords: [],
  summary: '',
  author: '',
}

export interface Asset {
  name: string
  id: string
}

const toggleAssetManagerItem = () => {
  const assets = document.querySelector('asset-manager')
  const caption = assets ? 'Hide Asset Manager' : 'Asset Manager'
  const action = () => {
    if (assets) assets.remove()
    else document.body.append(assetManager())
  }
  return {
    icon: 'image',
    caption,
    action,
  }
}

function featuredImage(content: string): string[] {
  return (
    content.match(/!\[[^\]]+\]\((.*?)\)/) ||
    content.match(/<img[^>]+src="(.*?)"/) ||
    []
  )
}

export const { blog } = tosi({
  blog: {
    title: 'inconsequence',
    index: [] as BlogRef[],
    indexVisible: 'published',
    filterText: '',
    filtered: [] as BlogRef[],
    visiblePosts: 6,
    currentPost: { ...emptyPost },
    editorPost: { ...emptyPost },
    otherPosts: [] as BlogPost[],
    filterIndex(filterText?: string) {
      if (filterText !== undefined) {
        blog.filterText.xinValue = filterText
      }
      const visible =
        blog.indexVisible.valueOf() === 'published'
          ? (ref: { date?: any }) => !!ref.date
          : (ref: { date?: any }) => !ref.date
      if (blog.filterText) {
        const needle = blog.filterText.toLocaleLowerCase()
        blog.filtered.xinValue = blog.index.xinValue
          .filter(visible)
          .filter(
            (ref) =>
              ref.title.toLocaleLowerCase().includes(needle) ||
              (ref.keywords &&
                ref.keywords.find((word) => word.includes(needle)))
          )
          .sort(recentFirst)
      } else {
        blog.filtered.xinValue = blog.index.xinValue
          .filter(visible)
          .sort(recentFirst)
      }
    },
    route: '/blog',
    linkFromRef(ref: BlogRef): string {
      const date = ref.date != '' ? new Date(ref.date as string) : new Date()
      return `${blog.route}/${date.getFullYear()}/${
        date.getMonth() + 1
      }/${date.getDate()}/${ref.path}`
    },
    async getIndex(c = 30, skipPrefetched = false): Promise<BlogPost[]> {
      const recentPosts = await getPrefetchedDoc('recentPosts', false)
      if (!skipPrefetched && recentPosts && recentPosts.length >= c) {
        return recentPosts
      }
      const roles = app.user.roles.xinValue || []
      const o =
        roles.includes('author') || roles.includes('editor') ? '' : 'date(desc)'
      return await service.docs.get({
        p: 'post',
        f: 'title,date,summary,keywords,path',
        o,
        c,
      })
    },
    async restoreIndexCache() {
      const cached = JSON.parse(
        localStorage.getItem('blog-index-cache') || '[]'
      )
      for (const item of cached) {
        if (!blog.index.find((entry) => entry.path === item.path)) {
          blog.index.push(item)
        }
      }
      blog.filterIndex()
    },
    async getLatest(count = 1): Promise<BlogPost[]> {
      const latestPosts = (await getPrefetchedDoc(
        'latestPosts',
        false
      )) as string[]
      if (latestPosts && latestPosts.length >= count) {
        return Promise.all(
          latestPosts
            .slice(0, count)
            .map((path: string) => getPrefetchedDoc(`post/path=${path}`, false))
        )
      } else {
        console.log(`fetching ${count} latest posts`)
        return await service.docs.get({
          p: 'post',
          c: count,
          o: 'date(desc)',
        })
      }
    },
    async getPost(id?: string): Promise<BlogPost | undefined> {
      let p: string
      if (!id) {
        const [ref] = await blog.getLatest()
        p = ref._path as string
      } else {
        p = `post/${id}`
      }
      return getPrefetchedDoc(p)
    },
    async onLinkClick(event: Event) {
      event.stopPropagation()
      event.preventDefault()
      const post = getListItem(event.target as HTMLElement)
      if (post.content) {
        blog.currentPost = post
      } else {
        const loaded = await blog.loadPost(`post/path=${post.path}`, post.title)
        if (!loaded) return
      }
      const path = blog.linkFromRef(blog.currentPost as unknown as BlogRef)
      window.history.pushState({ path }, '', path)
      const blogElement = document.querySelector('xin-blog') as XinBlog
      if (blogElement) {
        blogElement.showPost()
      }
    },
    async postPathFromLocation(): Promise<string | undefined> {
      const path = window.location.pathname
      let [, , postPath] = path.match(/\/blog\/(\d+\/)*([\w-]+)\/?$/) || []
      if (postPath) {
        return `post/path=${postPath}`
      }
      const urlParams = new URLSearchParams(window.location.search)
      const postId = urlParams.get('p')
      if (postId) {
        return `post/${postId}`
      }
      const latestPosts = await getPrefetchedDoc('latestPosts', false)
      if (latestPosts && latestPosts.length) {
        return `post/path=${latestPosts[0]}`
      }
    },
    async loadPost(p?: string, title = 'post'): Promise<BlogPost | undefined> {
      if (!p) {
        p = await blog.postPathFromLocation()
        if (!p) {
          return
        }
      }
      const closeNotification = postNotification({
        message: `loading ${title}`,
        type: 'progress',
      })
      const post = await getPrefetchedDoc(p)
      closeNotification()
      if (post) {
        blog.currentPost = post
        return post as BlogPost
      } else {
        postNotification({
          message: 'load failed',
          type: 'error',
          duration: 2,
        })
      }
    },
    async editPost(post?: BlogPost) {
      post = xinValue(post)
      // @ts-ignore-error
      blog.editorPost = post
        ? {
            ...post,
            content:
              post.format === 'markdown'
                ? post.content
                : await htmlToMarkdown(post.content),
            format: 'markdown',
          }
        : {
            ...emptyPost,
            author: app.user.name.valueOf(),
            title: 'untitled blog post',
          }
      document.body.append(xinPostEditor({ post: blog.editorPost }))
    },
  },
})

async function initBlog() {
  console.time('post loaded')

  const post = await blog.loadPost()
  if (post) {
    console.timeEnd('post loaded')
  }

  console.time('recent posts loaded')
  // @ts-ignore-error
  const posts = await blog.getLatest(blog.visiblePosts)

  if (!blog.currentPost || blog.currentPost.content.xinValue === '') {
    // @ts-ignore-error
    blog.currentPost = posts[0] || emptyPost
    console.timeEnd('post loaded')
  }

  // @ts-ignore-error
  blog.otherPosts = [...posts]
  console.timeEnd('recent posts loaded')

  console.time('blog index loaded')
  // @ts-ignore-error
  blog.index = await blog.getIndex()
  blog.filterIndex()
  console.timeEnd('blog index loaded')

  blog.restoreIndexCache()
}

initBlog().then(() => {
  console.log('blog loaded')
})

const {
  div,
  h1,
  h2,
  h3,
  p,
  a,
  span,
  img,
  nav,
  label,
  input,
  button,
  textarea,
  template,
  xinSlot,
} = elements

bindings.date = {
  toDOM(element, dateString) {
    element.textContent = dateString
      ? new Date(dateString).toLocaleDateString()
      : 'Not Published'
  },
}

bindings.image = {
  toDOM(element, content) {
    if (!content || !content.match) {
      content = 'no content found'
    }
    const [, src] = featuredImage(content)
    const [, alt] = content.match(/!\[([^\]]+)\]\(.*?\)/) ||
      content.match(/<img[^>]+alt="(.*?)"/) || ['illustration']

    element.textContent = ''
    if (src) {
      element.append(img({ alt: alt, src }))
    }
  },
}

bindings.blogLink = {
  toDOM(element, blogRef) {
    if (blogRef) {
      const link = blog.linkFromRef(blogRef)
      element.setAttribute('href', link)
      element.classList.toggle('draft', !blogRef.date)
    }
  },
}

bindings.visibleIfAuthor = {
  toDOM(element, user) {
    element.classList.toggle('author', user.roles?.includes('author'))
  },
}

bindings.hideCurrentPost = {
  toDOM(element, currentPostPath) {
    const post = getListItem(element)
    if (post.path === currentPostPath) {
      element.setAttribute('hidden', '')
    } else {
      element.removeAttribute('hidden')
    }
  },
}

interface PostParts extends PartsMap {
  html: MarkdownViewer
}

export class XinBlogPost extends Component<PostParts> {
  #post = null as BlogPost | null

  get post(): BlogPost | null {
    return this.#post
  }

  set post(post: BlogPost | null) {
    this.#post = post
    this.queueRender()
  }

  get html(): string {
    return this.parts.html.innerHTML
  }

  async getMarkdown(): Promise<string> {
    return htmlToMarkdown(this.parts.html.innerHTML)
  }

  content = () =>
    div(
      div(
        { style: { display: 'flex' } },
        xinSlot({ name: 'before-title' }),
        h1({
          part: 'title',
          style: { marginTop: 0, flex: '1 1 auto' },
        }),
        xinSlot()
      ),
      markdownViewer({
        part: 'html',
        didRender(this: MarkdownViewer) {
          LiveExample.insertExamples(this, {
            tosijs,
            tosijsui,
            xinjs: tosijs,
            xinjsui: tosijsui,
          })
        },
      }),
      p(
        { style: { textAlign: 'right', marginTop: vars.xinBlogPad } },
        '— ',
        span({ part: 'author' }),
        ', ',
        span({ part: 'date' })
      )
    )
  render() {
    super.render()

    const { title, html, author, date } = this.parts
    if (this.post) {
      title.textContent = this.post.title
      html.value = this.post.content
      author.textContent = this.post.author
      date.textContent = this.post.date
        ? new Date(this.post.date).toLocaleDateString()
        : 'Not Published'
    }
  }
}

export const xinBlogPost = XinBlogPost.elementCreator({ tag: 'xin-blog-post' })

export class XinBlogPostList extends Component {
  list = blog.otherPosts

  content = () =>
    div(
      {
        bindList: {
          value: this.list,
          idPath: '_path',
        },
      },
      template(
        div(
          { class: 'post-summary', bindHideCurrentPost: blog.currentPost.path },
          div(
            { class: 'row', style: { alignItems: 'baseline' } },
            a(
              {
                bindBlogLink: '^',
                onClick: blog.onLinkClick,
                style: { flex: '0 0 60%' },
              },
              h3({ bindText: '^.title' })
            ),
            span({ class: 'elastic' }),
            p({ bindDate: '^.date' })
          ),
          div(
            { class: 'row' },
            div({ bindImage: '^.content' }),
            div(
              { class: 'stack' },
              p({ bindText: '^.summary' }),
              p(
                a(
                  { bindBlogLink: '^', onClick: blog.onLinkClick },
                  'Read the post…'
                )
              )
            )
          )
        )
      )
    )
}

export const xinBlogPostList = XinBlogPostList.elementCreator({
  tag: 'xin-blog-post-list',
})

export class XinBlog extends Component {
  search = () => {
    const nav = this.parts.sidenav as SideNav
    if (nav.compact) {
      nav.contentVisible = false
      this.parts.search.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }

  showPost() {
    const nav = this.parts.sidenav as SideNav
    nav.contentVisible = true
    document.body.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  showBlogMenu = () => {
    popMenu({
      target: this.parts.menuTrigger as HTMLElement,
      menuItems: [
        {
          icon: 'filePlus',
          caption: 'New Post',
          action() {
            blog.editPost()
          },
        },
        {
          icon: 'file',
          caption: 'Reopen Draft',
          enabled: () => !!localStorage.getItem('xin-blog-editor-post'),
          action() {
            blog.editPost(
              JSON.parse(localStorage.getItem('xin-blog-editor-post') || '{}')
            )
          },
        },
        {
          icon: 'edit',
          caption: 'Edit Post',
          enabled: () => !!blog.currentPost.content,
          action() {
            // @ts-ignore-error
            blog.editPost(blog.currentPost)
          },
        },
        null,
        toggleAssetManagerItem(),
      ],
    })
  }

  connectedCallback() {
    super.connectedCallback()

    window.addEventListener('popstate', () => {
      blog.loadPost()
    })
  }

  content = () =>
    sideNav(
      {
        part: 'sidenav',
        navSize: 250,
        minSize: 700,
        style: {
          flex: '1 1 auto',
          overflow: 'hidden',
        },
      },
      div(
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            padding: vars.xinBlogPad,
            gap: vars.xinBlogPad,
          },
        },
        xinBlogPost(
          {
            post: blog.currentPost,
          },
          button(
            {
              part: 'show-sidebar',
              slot: 'before-title',
              class: 'iconic',
              style: {
                marginLeft: vars.xinBlogPad_100,
              },
              title: 'show navigation',
              onClick: this.search,
            },
            icons.chevronLeft()
          ),
          button(
            {
              part: 'menuTrigger',
              title: 'Blog Menu',
              class: 'iconic',
              onClick: this.showBlogMenu,
              bindVisibleIfAuthor: app.user,
              style: {
                marginRight: vars.xinBlogPad_100,
              },
            },
            icons.blog()
          )
        ),
        h2('Recent Posts'),
        xinBlogPostList()
      ),
      xinBlogSearch({ part: 'search', slot: 'nav' })
    )
}

export const xinBlog = XinBlog.elementCreator({
  tag: 'xin-blog',
  styleSpec: {
    'xin-blog, xin-blog-post, xin-blog-search, xin-post-editor': {
      _xinBlogPad: varDefault.pad('10px'),
      _xinBlogBodyBg: varDefault.bodyBg('white'),
      _spacing: varDefault.pad('10px'),
      _xinTabsSelectedColor: varDefault.brandColor('blue'),
      _xinTabsBarColor: vars.paleBrandColor,
    },

    ':host [part="menuTrigger"]:not(.author)': {
      visibility: 'hidden',
    },

    ':host [part="showMode"]:not(.author)': {
      display: 'none',
    },

    ':host xin-sidenav:not([compact]) [part="show-sidebar"]': {
      display: 'none',
    },

    ':host xin-blog-search, :host nav': {
      height: '100%',
    },
  },
})

export class XinBlogSearch extends Component {
  loadIndex = async () => {
    const closeNotification = postNotification({
      message: `downloading full index`,
      type: 'progress',
    })
    // @ts-ignore-error
    blog.index = await blog.getIndex(2000, true)
    localStorage.setItem(
      'blog-index-cache',
      JSON.stringify(blog.index.valueOf())
    )
    blog.filterIndex()
    closeNotification()
    ;(this.parts.searchField as HTMLInputElement).placeholder =
      'search all posts'
    ;(this.parts.downloadIndex as HTMLButtonElement).remove()
  }

  content = () =>
    nav(
      {
        class: 'responsive-stack padded',
        style: {
          _baseWidth: vars.listWidth,
        },
      },
      div(
        {
          class: 'responsive-stack',
          style: {
            flex: `0 0 calc(100vh - 82px - ${vars.xinBlogPad200})`,
            gap: vars.xinBlogPad,
          },
        },
        div(
          {
            style: {
              display: 'flex',
            },
          },
          input({
            part: 'searchField',
            placeholder: 'search recent posts',
            type: 'search',
            style: {
              margin: '2px',
              minWidth: '10px',
              flex: '1 1 auto',
            },
            onInput(event: Event) {
              blog.filterIndex((event.target as HTMLInputElement).value)
            },
          }),
          button(
            {
              title: 'Download Full Index',
              part: 'downloadIndex',
              class: 'iconic',
              style: {
                flex: '0 0 36px',
                height: '36px',
                lineHeight: '36px',
              },
              onClick: this.loadIndex,
            },
            icons.downloadCloud()
          )
        ),
        xinSegmented('Show', {
          part: 'showMode',
          value: 'published',
          choices: 'published,drafts',
          bindValue: blog.indexVisible,
          bindVisibleIfAuthor: app.user,
          onChange() {
            blog.filterIndex()
          },
          style: {
            _segmentedOptionCurrentBackground: vars.brandColor,
            _segmentedOptionCurrentColor: vars.brandTextColor,
          },
        }),
        div(
          {
            class: 'stack elastic',
            style: {
              overflowY: 'auto',
            },
            bindList: {
              value: blog.filtered,
              idPath: '_path',
            },
          },
          template(
            a({
              class: 'nopad nomargin nowrap ellipsis rigid',
              bindText: '^.title',
              bindBlogLink: '^',
              onClick: blog.onLinkClick,
            })
          )
        )
      )
    )
}

export const xinBlogSearch = XinBlogSearch.elementCreator({
  tag: 'xin-blog-search',
})

interface PostEditorParts extends PartsMap {
  title: HTMLInputElement
  source: CodeEditor
  preview: MarkdownViewer
  tabSelector: TabSelector
}

export class XinPostEditor extends Component<PostEditorParts> {
  updateContent = () => {
    const { source, preview } = this.parts

    blog.editorPost.content.xinValue = source.value
    preview.post = { ...blog.editorPost }
  }

  tabChanged = (event: Event) => {
    if (!(event.target instanceof TabSelector)) {
      return
    }

    if (this.parts.tabSelector.value > 0) {
      const { source, preview } = this.parts

      blog.editorPost.content.xinValue = source.value
      preview.post = { ...blog.editorPost }
    }
  }

  closeEditor = () => {
    const { source } = this.parts
    blog.editorPost.content.xinValue = source.value

    localStorage.setItem(
      'xin-blog-editor-post',
      JSON.stringify(blog.editorPost.valueOf())
    )
    this.remove()
  }

  savePost = async () => {
    const { source } = this.parts
    blog.editorPost.content.xinValue = source.value

    let method: ServiceRequestType = 'put'
    if (!blog.editorPost._path) {
      // @ts-ignore-error
      blog.editorPost._path = `post/${randomID()}`
      method = 'post'
    }
    this.updateContent()
    const closeNotification = postNotification({
      message: `saving ${blog.editorPost.title}`,
      type: 'progress',
    })
    localStorage.setItem(
      'xin-blog-editor-post',
      JSON.stringify(blog.editorPost.valueOf())
    )
    const data = xinValue(blog.editorPost)
    const result = await service.doc[method]({ p: data._path, data })
    closeNotification()
    if (result instanceof Error) {
      postNotification({
        message: result.toString(),
        type: 'error',
      })
    } else {
      blog.loadPost(data._path!.xinValue)
      localStorage.removeItem('xin-blog-editor-post')
    }
  }

  unpublish = () => {
    blog.editorPost.date!.xinValue = ''
  }

  proofread = async () => {
    const title = this.parts.title.value
    const content = this.parts.source.value
      .split('\n')
      .map((line, number) => `${number}: ${line}`)
      .join('\n')
    const close = postNotification({
      message: 'Proofreading…',
      type: 'progress',
    })
    const { text } = await service.gen.post({
      prompt: `Please proofread the following blog post, titled "${title}" (it is in markdown format, it contains some code blocks with type annotations):\n\n ${content}\n\nProvide the feedback as a list of line numbers (starting at 0) followed by a space and a description of the issue (one line per issue, e.g. 12 here is a problem\\n32 "teh" should be "the"). Please do not include a preamble to simplify parsing.`,
    })
    close()
    try {
      const issues = text
        .split('\n')
        .map((line: string) => {
          const [, rowNumber, content] = line.match(/^(\d+)\s(.*)$/) || []
          const row = Number(rowNumber)
          if (content || !isNaN(row)) {
            return [
              {
                row,
                text: content,
                type: 'warning',
              },
            ]
          } else {
            return []
          }
        })
        .flat()
      console.log(issues)
      this.parts.source.editor.getSession().setAnnotations(issues)
    } catch (e) {
      console.error(e)
      console.log(text)
      postNotification({
        type: 'error',
        message: 'bad response / error—see console for details',
      })
    }
  }

  summarize = async () => {
    const content = this.parts.source.value
    const close = postNotification({
      message: 'Summarizing…',
      type: 'progress',
    })
    const { text } = await service.gen.post({
      prompt: `Please write a short teaser paragraph for the following blog post in the style of the author. The post is provided below in markdown format:\n\n ${content}`,
    })
    blog.editorPost.summary = text
    close()
  }

  convertToMarkdown = async () => {
    this.parts.source.value = await this.parts.preview.getMarkdown()
    this.parts.tabSelector.value = 0
  }

  publishNow = () => {
    blog.editorPost.date!.xinValue = new Date().toISOString()
  }

  showEditorMenu = () => {
    popMenu({
      target: this.parts.menuTrigger as HTMLElement,
      menuItems: [
        toggleAssetManagerItem(),
        {
          caption: 'Proofread',
          icon: 'checkCircle',
          action: this.proofread,
        },
        {
          caption: 'Save',
          icon: 'uploadCloud',
          action: this.savePost,
        },
        null,
        {
          caption: 'Close',
          icon: 'x',
          action: this.closeEditor,
        },
      ],
    })
  }

  content = () =>
    div(
      {
        style: {
          position: 'fixed',
          background: vars.xinBlogBodyBg,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          gap: vars.xinBlogPad,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        },
      },
      tabSelector(
        {
          part: 'tabSelector',
          style: {
            flex: '1 1 auto',
          },
          onChange: this.tabChanged,
        },
        button(
          {
            slot: 'after-tabs',
            part: 'menuTrigger',
            title: 'Editor Menu',
            class: 'iconic',
            onClick: this.showEditorMenu,
            style: {
              height: '40px',
              lineHeight: '40px',
            },
          },
          icons.chevronDown()
        ),
        div(
          {
            name: 'Markdown',
            style: {
              height: '100%',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'stretch',
              gap: vars.xinBlogPad50,
            },
          },
          input({
            part: 'title',
            bindValue: blog.editorPost.title,
            style: {
              marginTop: vars.xinBlogPad50,
            },
          }),
          codeEditor({
            part: 'source',
            value: blog.editorPost.content.valueOf(),
            style: {
              flex: '1 1 auto',
              resize: 'none',
            },
            options: {
              wrap: true,
            },
          })
        ),
        div(
          { name: 'Preview', style: { padding: vars.xinBlogPad } },
          xinBlogPost({
            part: 'preview',
            post: blog.editorPost,
          })
        ),
        div(
          { name: 'Metadata', style: { padding: vars.xinBlogPad } },
          label(span('Path'), input({ bindValue: blog.editorPost.path })),
          label(
            div(
              {
                class: 'row',
                style: { gap: vars.pad50 },
              },
              span('Publication Date'),
              span({ class: 'elastic' }),
              button('Unpublish', { onClick: this.unpublish }),
              button('Publish Now', { onClick: this.publishNow })
            ),
            input({ part: 'publicationDate', bindValue: blog.editorPost.date })
          ),
          label(
            div(
              {
                class: 'row',
                style: { gap: vars.pad50 },
              },
              span('Summary'),
              span({ class: 'elastic' }),
              button('Generate Summary', {
                onClick: this.summarize,
              })
            ),
            textarea({ bindValue: blog.editorPost.summary })
          )
        )
      )
    )
}

export const xinPostEditor = XinPostEditor.elementCreator({
  tag: 'xin-post-editor',
  styleSpec: {
    ':host label': {
      display: 'flex',
      flexDirection: 'column',
      gap: vars.xinBlogPad50,
      margin: `${vars.xinBlogPad50} 0`,
      alignItems: 'stretch',
    },
    ':host textarea': {
      width: '100%',
      resize: 'vertical',
      minHeight: '200px',
      fontFamily: vars.codeFont,
      fontSize: '16px',
    },
    ':host xin-code': {
      fontFamily: vars.codeFont,
    },
    '.ace-tooltip': {
      maxWidth: 300,
      wordWrap: 'break-word',
      whiteSpace: 'pre-wrap !important',
    },
    ':host input': {
      margin: '2px',
    },
    ':host xin-word [part=doc]': {
      overflowY: 'auto',
      padding: vars.xinBlogPad,
    },
  },
})
