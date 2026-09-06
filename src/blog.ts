import {
  tosi,
  Component,
  elements,
  vars,
  varDefault,
  bindings,
  getListItem,
  tosiValue,
  PartsMap,
} from 'tosijs'
import { isPublished, UNPUBLISHED_DATE } from '../functions/shared/post'
import {
  formatBlogDate,
  slugify,
  computeProofNotes,
  inferResolutions,
  type ProofNote,
} from './blog-pure'
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
  tosiSegmented,
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
        blog.filterText.value = filterText
      }
      const visible =
        blog.indexVisible.valueOf() === 'published'
          ? (ref: { date?: any }) => isPublished(ref)
          : (ref: { date?: any }) => !isPublished(ref)
      if (blog.filterText) {
        const needle = blog.filterText.toLocaleLowerCase()
        blog.filtered.value = blog.index.value
          .filter(visible)
          .filter(
            (ref) =>
              ref.title.toLocaleLowerCase().includes(needle) ||
              (ref.keywords &&
                ref.keywords.find((word) => word.includes(needle)))
          )
          .sort(recentFirst)
      } else {
        blog.filtered.value = blog.index.value.filter(visible).sort(recentFirst)
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
      const roles = app.user.roles.value || []
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
      post = tosiValue(post)
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

  if (!blog.currentPost || blog.currentPost.content.value === '') {
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
    element.textContent = formatBlogDate(dateString)
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
      date.textContent = formatBlogDate(this.post.date)
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
      _tosiTabsSelectedColor: varDefault.brandColor('blue'),
      _tosiTabsBarColor: vars.paleBrandColor,
    },

    ':host [part="menuTrigger"]:not(.author)': {
      visibility: 'hidden',
    },

    ':host [part="showMode"]:not(.author)': {
      display: 'none',
    },

    ':host tosi-sidenav:not([compact]) [part="show-sidebar"]': {
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
        tosiSegmented('Show', {
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
  proofBar: HTMLDivElement
}

// The live CodeMirror EditorView, as exposed by <tosi-code>.editor — derived from
// the element's own type so we never import @codemirror (which would load a second
// instance; see tosijs-ui#131).
type CmView = NonNullable<CodeEditor['editor']>


export class XinPostEditor extends Component<PostEditorParts> {
  // The resolved doc path, remembered across re-saves within this editor session
  // (a generated `_path` cannot be written back onto the editorPost proxy).
  #path = ''

  #editorExtended = false
  // editor text captured when a proofread diff opens: the pre-proofread text (so
  // Cancel can restore it) and the full proofread revision (so Apply can infer,
  // from before + revised + resolved, which side of each hunk the reviewer chose).
  #proofBefore = ''
  #proofRevised = ''
  /**
   * True while the proofreading diff is open for review.
   *
   * This is a DATA-LOSS guard, not cosmetics. While the diff is open,
   * `source.value` holds the model's full revision (that is what the overlay
   * diffs against `source.original`), and the reviewer's decisions are not
   * applied until Apply. The overlay renders inside `<tosi-code>`'s shadow root
   * and covers only the EDITOR — the tab strip and the editor menu stay live —
   * so every action that reads `source.value` and persists it would silently
   * commit the un-reviewed rewrite over the author's text, with a success toast.
   * Re-running Proofread would additionally overwrite `#proofBefore`, making the
   * author's original unrecoverable.
   */
  #proofOpen = false

  /** Refuse an action that would persist or destroy un-reviewed proofread text. */
  #blockedByProofread = (what: string): boolean => {
    if (!this.#proofOpen) return false
    postNotification({
      type: 'warn',
      message: `Finish reviewing the proofreading suggestions first (Apply or Cancel) before ${what}.`,
      duration: 4,
    })
    return true
  }

  connectedCallback() {
    super.connectedCallback()
    this.#installCaret()
  }

  // ── Margin annotations (no @codemirror import) ───────────────────────────
  // Plain DOM markers positioned over the editor via the live EditorView's OWN
  // geometry (`coordsAtPos`) and DOM (`.dom` / `.scrollDOM`). A CM gutter would
  // need `gutter()` from @codemirror/view *in this app*, which loads a second
  // module instance and crashes the editor (see tosijs-ui#131). This reads only
  // the EditorView the editor already exposes, so it imports nothing and can't
  // collide. Markers track their line: repositioned on scroll/resize, hidden
  // when the line scrolls out of the rendered viewport.
  #annoLayer: HTMLDivElement | null = null
  #annos: Array<{ line: number; el: HTMLElement }> = []

  #ensureAnnoLayer = (view: CmView): HTMLDivElement => {
    if (this.#annoLayer && this.#annoLayer.isConnected) return this.#annoLayer
    const layer = document.createElement('div')
    Object.assign(layer.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      overflow: 'hidden',
    })
    // .cm-editor is position:relative, so an absolute child anchors to it.
    view.dom.appendChild(layer)
    this.#annoLayer = layer
    const reposition = () => this.#repositionAnnos(view)
    view.scrollDOM.addEventListener('scroll', reposition, { passive: true })
    // editing shifts line positions; contentDOM 'input' bubbles typing/paste
    view.contentDOM.addEventListener('input', reposition)
    new ResizeObserver(reposition).observe(view.dom)
    return layer
  }

  #clearAnnotations = () => {
    for (const a of this.#annos) a.el.remove()
    this.#annos = []
  }

  #repositionAnnos = (view: CmView) => {
    const editorRect = view.dom.getBoundingClientRect()
    for (const a of this.#annos) {
      const lineNo = Math.min(Math.max(a.line, 1), view.state.doc.lines)
      const coords = view.coordsAtPos(view.state.doc.line(lineNo).from)
      if (!coords) {
        a.el.style.display = 'none'
        continue
      }
      a.el.style.display = ''
      a.el.style.top = `${coords.top - editorRect.top}px`
    }
  }

  addLineAnnotation = (
    line: number,
    opts: { icon: Element; title: string; color?: string; bg?: string },
    tries = 0
  ) => {
    const view = this.parts.source.editor
    if (!view) {
      if (tries < 40) {
        setTimeout(() => this.addLineAnnotation(line, opts, tries + 1), 75)
      }
      return
    }
    const layer = this.#ensureAnnoLayer(view)
    const el = document.createElement('div')
    el.title = opts.title
    // tosijs-ui icons stroke with currentColor; size explicitly (raw icon SVGs may
    // carry their own width/height attributes, which CSS width/height overrides)
    const icon = opts.icon as SVGElement
    icon.style.setProperty('--tosi-icon-size', '15px')
    icon.style.width = '15px'
    icon.style.height = '15px'
    icon.style.display = 'block'
    el.appendChild(icon)
    Object.assign(el.style, {
      position: 'absolute',
      right: '6px',
      display: 'flex',
      alignItems: 'center',
      padding: '2px',
      borderRadius: '3px',
      background: opts.bg ?? 'rgba(255,179,0,0.18)',
      color: opts.color ?? '#ffb300',
      pointerEvents: 'auto',
      cursor: 'help',
    })
    layer.appendChild(el)
    this.#annos.push({ line, el })
    this.#repositionAnnos(view)
  }

  // tosijs-ui doesn't colour the CM6 caret, so it defaults to dark — invisible on
  // our dark editor bg. Inject a shadow-root style with `!important` (beats CM6's
  // own StyleModule) + an explicit light colour. The rule applies whenever the
  // cursor renders, so it doesn't depend on the (lazy) editor being loaded yet —
  // we only need the <tosi-code> shadow root to exist.
  #installCaret = (tries = 0) => {
    const source = this.parts.source
    const sr = source && source.shadowRoot
    if (!sr) {
      if (tries < 40) setTimeout(() => this.#installCaret(tries + 1), 75)
      return
    }
    if (this.#editorExtended) return
    this.#editorExtended = true
    const st = document.createElement('style')
    st.textContent =
      '.cm-cursor, .cm-cursor-primary { border-left-color: var(--text-color, #fbfbfb) !important; border-left-width: 2px !important; }'
    sr.appendChild(st)
  }

  updateContent = () => {
    const { source, preview } = this.parts

    blog.editorPost.content.value = source.value
    preview.post = { ...blog.editorPost }
  }

  tabChanged = (event: Event) => {
    if (!(event.target instanceof TabSelector)) {
      return
    }

    if (this.parts.tabSelector.value > 0) {
      const { source, preview } = this.parts

      blog.editorPost.content.value = source.value
      preview.post = { ...blog.editorPost }
    }
  }

  closeEditor = () => {
    if (this.#blockedByProofread('closing the editor')) return
    const { source } = this.parts
    blog.editorPost.content.value = source.value

    localStorage.setItem(
      'xin-blog-editor-post',
      JSON.stringify(blog.editorPost.valueOf())
    )
    this.remove()
  }

  savePost = async () => {
    if (this.#blockedByProofread('saving')) return
    const { source } = this.parts
    blog.editorPost.content.value = source.value
    this.updateContent()

    // Resolve the path from the UNWRAPPED post. The bug was the old guard
    // `if (!blog.editorPost._path)`: read straight off the live proxy, `_path`
    // is a *boxed* value (an object → always truthy), so the guard never fired,
    // a new post's path was never generated, and `p` went out empty → 400
    // "missing path". tosiValue() gives a clean plain object with primitive
    // leaves (undefined for a missing key), so resolve/generate the path from
    // that, remember it on the component for re-saves, and pass it explicitly.
    const data = tosiValue(blog.editorPost) as any

    // Resolve the doc path: an existing post's `_path`, one we created earlier
    // this session, else a fresh id for a brand-new post. (Scalars read off the
    // live proxy are boxed/always-truthy — hence tosiValue and this.#path.)
    let path = (data._path as string) || this.#path
    const method: ServiceRequestType = path ? 'put' : 'post'
    if (!path) {
      path = `post/${randomID()}`
    }
    data._path = path

    // Ensure a URL slug. A new post has an empty `path`; without one the permalink
    // becomes /undefined and the post can't be found by its slug. Generate from the
    // title when empty; normalise whatever the author typed either way.
    const typedSlug = String(data.path ?? '').trim()
    data.path = typedSlug ? slugify(typedSlug) : slugify(String(data.title ?? ''))
    // reflect the resolved slug in the Metadata field
    ;(blog.editorPost.path as any).value = data.path

    const closeNotification = postNotification({
      message: `saving ${data.title}`,
      type: 'progress',
    })
    localStorage.setItem('xin-blog-editor-post', JSON.stringify(data))
    const result = await service.doc[method]({ p: path, data })
    closeNotification()
    if (result instanceof Error) {
      // The server enforces unique title/path — surface that clearly instead of
      // the raw message.
      const msg = result.toString()
      postNotification({
        type: 'error',
        message: /unique/i.test(msg)
          ? /"title"/.test(msg)
            ? 'Another post already has this title — change it and save again.'
            : `The slug "${data.path}" is already taken — change it and save again.`
          : msg,
      })
      return
    }
    // remember the path only on SUCCESS, so a failed create isn't retried as a PUT
    this.#path = path
    localStorage.removeItem('xin-blog-editor-post')
    // Reflect the save in the underlying open post: drop stale prefetch entries,
    // fetch the canonical doc fresh, update currentPost, and set the address bar.
    if (window.prefetched) {
      delete window.prefetched[path]
      if (data.path) {
        delete window.prefetched[`post/path=${data.path}`]
      }
    }
    const fresh = await service.doc.get({ p: path })
    const savedPost = fresh instanceof Error || !fresh ? data : fresh
    // @ts-ignore-error currentPost accepts a plain post object
    blog.currentPost = savedPost
    // savedPost is a plain object, so linkFromRef reads primitive path/date — no
    // /undefined. Guard against a draft with no date producing NaN in the URL.
    try {
      const link = blog.linkFromRef(savedPost as unknown as BlogRef)
      if (link && !link.includes('/undefined') && !link.includes('NaN')) {
        window.history.pushState({ path: link }, '', link)
      }
    } catch (e) {
      console.error('failed to set post url', e)
    }
  }

  unpublish = () => {
    blog.editorPost.date!.value = UNPUBLISHED_DATE
  }

  proofread = async () => {
    if (this.#blockedByProofread('starting another proofread')) return
    const { source } = this.parts
    const md = this.fullPostMarkdown()
    const close = postNotification({
      message: 'Proofreading & fact-checking…',
      type: 'progress',
    })
    let revised = ''
    try {
      const res = await service.gen.post({
        modelId: 'gemini-2.5-pro',
        prompt:
          'You are a meticulous copy editor and fact-checker. Below is a blog post in ' +
          'Markdown; the title is the H1 at the top (given for context).\n\n' +
          'Return a corrected and improved version of the post BODY only — do NOT include ' +
          'the H1 title line. Fix spelling, grammar, punctuation and clarity; tighten weak ' +
          'phrasing; verify factual claims and any URLs and correct anything that is wrong; ' +
          "preserve the author's voice, meaning and ALL Markdown formatting including code " +
          'blocks (never alter code). Output ONLY the revised body Markdown — no preamble, ' +
          'no commentary, and do not wrap the whole thing in a code fence.\n\n' +
          md,
      })
      close()
      if (res instanceof Error) throw res
      revised = String(res?.text ?? '')
        .trim()
        // drop a stray leading title heading if the model echoed one
        .replace(/^#[^\n]*\n+/, '')
        .trim()
    } catch (e) {
      close()
      console.error('proofread failed', e)
      postNotification({
        type: 'error',
        message: 'Proofreading failed — see console',
      })
      return
    }
    if (!revised || revised === source.value.trim()) {
      postNotification({
        type: 'success',
        message: 'No changes suggested',
        duration: 3,
      })
      return
    }
    this.openProofreadDiff(revised)
  }

  // Show the proofreader's revision as a resolvable diff, rendered IN PLACE by the
  // editor's own diff overlay (tosi-code 1.12.8: click a side of any change to pick
  // it, with word-level highlighting). The overlay compares `source.original` vs
  // `source.value`; on `showDiff(false)` the resolved text lands back in
  // `source.value`. We put the reviewer's own text on the `original` side and the
  // revision on the `value` side, so unresolved hunks default to accepting the
  // suggestion and the reviewer reverts the ones they'd rather keep.
  openProofreadDiff = (revised: string) => {
    const source = this.parts.source
    this.#proofBefore = source.value
    this.#proofRevised = revised
    source.original = this.#proofBefore
    source.diffResolvable = true
    source.diffOriginalLabel = 'Yours'
    source.diffModifiedLabel = 'Proofread'
    source.value = revised
    source.showDiff(true)
    this.#proofOpen = true
    this.parts.proofBar.style.display = 'flex'
  }

  // Commit the reviewer's resolutions: close the overlay (which writes the resolved
  // text into `source.value`), persist it, and annotate every hunk — green check for
  // an accepted suggestion, red x for one the reviewer rejected. We infer each
  // hunk's choice from before + revised + the resolved result (the overlay doesn't
  // report them), then pin a note to its line in the resolved text.
  applyProofread = () => {
    const source = this.parts.source
    source.showDiff(false)
    this.#proofOpen = false
    this.parts.proofBar.style.display = 'none'
    const after = source.value
    blog.editorPost.content.value = after
    try {
      const resolutions = inferResolutions(
        this.#proofBefore,
        this.#proofRevised,
        after
      )
      this.applyProofNotes(
        computeProofNotes(this.#proofBefore, this.#proofRevised, resolutions)
      )
    } catch (e) {
      console.error('proof notes failed', e)
    }
    postNotification({
      type: 'success',
      message: 'Proofreading edits applied',
      duration: 2,
    })
  }

  // Discard the suggestions. `showDiff(false)` always applies the overlay's current
  // resolution to `source.value`, so restore the captured pre-proofread text after.
  cancelProofread = () => {
    const source = this.parts.source
    source.showDiff(false)
    source.value = this.#proofBefore
    blog.editorPost.content.value = this.#proofBefore
    this.#proofOpen = false
    this.parts.proofBar.style.display = 'none'
  }

  // Render each landed proofreading edit as a margin annotation over the editor
  // (DOM overlay via addLineAnnotation — no @codemirror import). Session-scoped:
  // cleared and re-rendered on each Apply, not persisted.
  applyProofNotes = (notes: ProofNote[]) => {
    this.#clearAnnotations()
    for (const note of notes) {
      const accepted = note.accepted
      const title = accepted
        ? 'Proofreader edit — accepted' +
          (note.removed ? `\n\nwas:\n${note.removed}` : '') +
          (note.added ? `\n\nnow:\n${note.added}` : '')
        : 'Proofreader suggestion — rejected' +
          (note.removed ? `\n\nkept:\n${note.removed}` : '') +
          (note.added ? `\n\ndeclined:\n${note.added}` : '')
      this.addLineAnnotation(note.fromLine + 1, {
        icon: accepted ? icons.check() : icons.x(),
        title,
        color: accepted ? '#22c55e' : '#ef4444',
        bg: accepted ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)',
      })
    }
    console.info(`[proofread] ${notes.length} margin note(s) rendered`)
  }

  summarize = async () => {
    if (this.#blockedByProofread('generating a summary')) return
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
    if (this.#blockedByProofread('converting to markdown')) return
    this.parts.source.value = await this.parts.preview.getMarkdown()
    this.parts.tabSelector.value = 0
  }

  publishNow = () => {
    blog.editorPost.date!.value = new Date().toISOString()
  }

  // The whole post as markdown, with the title as an H1 on top. Shared by the
  // "Copy as Markdown" action and (soon) the proofreader.
  fullPostMarkdown = (): string => {
    const title = this.parts.title.value.trim()
    const body = this.parts.source.value
    return title ? `# ${title}\n\n${body}` : body
  }

  copyAsMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(this.fullPostMarkdown())
      postNotification({
        type: 'success',
        message: 'Post copied as Markdown',
        duration: 2,
      })
    } catch (e) {
      console.error('clipboard write failed', e)
      postNotification({
        type: 'error',
        message: 'Copy failed — clipboard unavailable',
      })
    }
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
          caption: 'Copy as Markdown',
          icon: 'copy',
          action: this.copyAsMarkdown,
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
          // Shown only while a proofread diff is open in the editor below. The diff
          // overlay covers the editor (its own shadow), not this bar, so Apply/Cancel
          // stay reachable above it.
          // Hidden via inline `display:none` (not `hidden`): the `.row` class sets
          // `display:flex`, which beats the UA `[hidden]{display:none}` rule, so
          // `hidden` alone wouldn't hide it. Toggled by open/apply/cancel below.
          div(
            {
              part: 'proofBar',
              class: 'row',
              style: {
                display: 'none',
                flex: '0 0 auto',
                alignItems: 'center',
                gap: vars.pad50,
              },
            },
            span(
              { class: 'elastic', style: { opacity: '0.8' } },
              'Reviewing proofreading suggestions — click a side of any change to pick it'
            ),
            button('Cancel', { onClick: this.cancelProofread }),
            button('Apply edits', { onClick: this.applyProofread })
          ),
          codeEditor({
            part: 'source',
            value: blog.editorPost.content.valueOf(),
            // posts are markdown; `mode` is part of the surviving 1.7 contract
            mode: 'markdown',
            style: {
              flex: '1 1 auto',
              resize: 'none',
            },
            // NOTE: the ACE-era `options: { wrap: true }` was removed in tosijs-ui
            // 1.7 (CodeMirror 6) — it had been a warn-once no-op, so line wrapping
            // was already off. Configure CM6 via `.editor` (EditorView) if wanted.
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
    ':host tosi-code': {
      fontFamily: vars.codeFont,
    },
    // was .ace-tooltip before tosijs-ui 1.7 swapped ACE for CodeMirror 6
    '.cm-tooltip': {
      maxWidth: 300,
      wordWrap: 'break-word',
      whiteSpace: 'pre-wrap !important',
    },
    ':host input': {
      margin: '2px',
    },
    ':host tosi-rich-text [part=doc]': {
      overflowY: 'auto',
      padding: vars.xinBlogPad,
    },
  },
})
