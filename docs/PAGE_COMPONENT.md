# Page Component

The page component (`src/page.ts`) is a generic content renderer that displays HTML or embeds other components.

## Overview

`xin-page` is a custom web component that:
- Renders arbitrary HTML content
- Embeds custom components (like `<xin-blog>`)
- Supports dynamic content loading
- Handles navigation and scrolling

## Basic Usage

```typescript
import { xinPage } from './page'

// Render HTML
xinPage({ 
  page: { 
    source: '<h1>Hello World</h1><p>This is a page.</p>' 
  } 
})

// Embed a component
xinPage({ 
  page: { 
    source: '<xin-blog></xin-blog>' 
  } 
})

// Multiple components
xinPage({ 
  page: { 
    source: `
      <div class="welcome">
        <h1>Welcome</h1>
        <xin-blog></xin-blog>
      </div>
    ` 
  } 
})
```

## Page Object Structure

```typescript
interface Page {
  source: string      // HTML content or component tags
  title?: string      // Page title (updates document.title)
  id?: string         // Optional page identifier
}
```

## Component Definition

The component is defined using tosijs:

```typescript
import { Component, elements } from 'tosijs'

export class XinPage extends Component {
  content = () => {
    const { div } = elements
    const page = this.initValue.page || { source: '' }
    
    return div(
      {
        class: 'xin-page',
        bindUnsafeHTML: { page: 'source' }
      }
    )
  }
}

Component.elementCreator({ XinPage })
```

## Key Features

### 1. Unsafe HTML Binding

The component uses `bindUnsafeHTML` to render arbitrary HTML:

```typescript
bindUnsafeHTML: { page: 'source' }
```

**Warning:** Only render trusted content. User-generated content should be sanitized.

### 2. Dynamic Component Embedding

When HTML includes custom element tags, they're automatically instantiated:

```html
<!-- This will create a functioning blog component -->
<xin-blog></xin-blog>

<!-- Multiple components work too -->
<xin-blog></xin-blog>
<xin-youtube video-id="dQw4w9WgXcQ"></xin-youtube>
```

### 3. Reactive Updates

The page content updates reactively when the source changes:

```typescript
const pageState = tosi({ 
  page: { 
    source: '<h1>Initial</h1>' 
  } 
})

// Later...
pageState.page.source = '<h1>Updated</h1>' // UI updates automatically
```

## Use Cases

### Static Pages

Create an "About" page:

```typescript
// functions/src/page.ts
COLLECTIONS.page = {
  unique: ['path'],
  access: {
    [ROLES.public]: { read: ALL, list: ALL },
    [ROLES.admin]: { write: ALL },
  }
}

// In Firestore, create a document:
{
  path: 'about',
  title: 'About Us',
  content: `
    <div class="about-page">
      <h1>About Our Company</h1>
      <p>We've been building great software since 2020...</p>
    </div>
  `
}
```

Load and display:

```typescript
const aboutPage = await fb.service.page['page/path=about'].get()
xinPage({ page: { source: aboutPage.content, title: aboutPage.title } })
```

### Landing Pages

```typescript
const landingPage = {
  source: `
    <div class="landing">
      <header class="hero">
        <h1>Welcome to Our Platform</h1>
        <button onclick="window.scrollTo(0, 1000)">Get Started</button>
      </header>
      
      <section class="features">
        <div class="feature">
          <h2>Fast</h2>
          <p>Lightning-fast performance</p>
        </div>
        <div class="feature">
          <h2>Secure</h2>
          <p>Bank-level security</p>
        </div>
      </section>
      
      <xin-blog></xin-blog>
    </div>
  `
}

xinPage({ page: landingPage })
```

### Component Composition

Combine multiple components:

```typescript
xinPage({ 
  page: { 
    source: `
      <nav class="sidebar">
        <xin-page-tree></xin-page-tree>
      </nav>
      <main>
        <xin-blog></xin-blog>
      </main>
    ` 
  } 
})
```

## Styling

Pages inherit global styles from `src/style.ts`.

Add page-specific styles:

```typescript
// In style.ts
const pageStyles = css`
  .xin-page {
    padding: var(--pad);
    max-width: 1200px;
    margin: 0 auto;
  }
  
  .xin-page h1 {
    font-size: 2rem;
    margin-bottom: var(--spacing);
  }
  
  .xin-page img {
    max-width: 100%;
    height: auto;
  }
`
```

Or use inline styles in the content:

```html
<style>
  .custom-section {
    background: var(--accent-color);
    padding: 2rem;
  }
</style>
<div class="custom-section">
  <h2>Special Section</h2>
</div>
```

## Navigation

### Client-Side Routing

Implement SPA navigation:

```typescript
function navigateToPage(pagePath: string) {
  // Fetch page data
  const page = await fb.service.page[`page/path=${pagePath}`].get()
  
  // Update page content
  xinPage({ page: { source: page.content, title: page.title } })
  
  // Update URL
  window.history.pushState({}, page.title, `/${pagePath}`)
  
  // Update document title
  document.title = page.title
}

// Handle back/forward
window.addEventListener('popstate', () => {
  const path = location.pathname.slice(1)
  navigateToPage(path)
})
```

### Link Handling

Intercept link clicks for SPA behavior:

```typescript
document.addEventListener('click', (e) => {
  const link = e.target.closest('a')
  if (!link || link.target === '_blank') return
  
  const href = link.getAttribute('href')
  if (href.startsWith('/') && !href.startsWith('//')) {
    e.preventDefault()
    navigateToPage(href.slice(1))
  }
})
```

## Page Collection

Create a collection for manageable pages:

```typescript
// functions/src/page.ts
import { COLLECTIONS } from './collections'
import { ROLES } from './roles'
import { ALL } from './access'

COLLECTIONS.page = {
  unique: ['path'],
  validate: async (page) => {
    if (!page.title?.trim()) {
      return new Error('Title is required')
    }
    if (!page.content?.trim()) {
      return new Error('Content is required')
    }
    return page
  },
  access: {
    [ROLES.public]: {
      read: ALL,
      list: ALL,
    },
    [ROLES.editor]: {
      write: ALL,
    },
  },
}
```

Document structure:

```typescript
interface PageDocument {
  id: string
  path: string         // URL path (e.g., "about", "contact")
  title: string        // Page title
  content: string      // HTML content
  parent?: string      // Parent page ID (for hierarchical pages)
  order?: number       // Sort order
  published?: boolean  // Visibility flag
}
```

## Page Editor

Create a simple page editor:

```typescript
import { elements, Component } from 'tosijs'

export class PageEditor extends Component {
  content = () => {
    const { div, label, input, textarea, button } = elements
    
    return div(
      { class: 'page-editor' },
      label('Title'),
      input({ 
        type: 'text',
        bindValue: 'editor.page.title'
      }),
      
      label('Path'),
      input({ 
        type: 'text',
        bindValue: 'editor.page.path'
      }),
      
      label('Content (HTML)'),
      textarea({ 
        bindValue: 'editor.page.content',
        rows: 20
      }),
      
      button({ 
        onClick: () => this.savePage() 
      }, 'Save'),
      
      button({ 
        onClick: () => this.previewPage() 
      }, 'Preview')
    )
  }
  
  async savePage() {
    const page = this.parts.editor.page
    if (page.id) {
      await fb.service.page[page.id].put(page)
    } else {
      await fb.service.page.post(page)
    }
  }
  
  previewPage() {
    const page = this.parts.editor.page
    xinPage({ page: { source: page.content } })
  }
}
```

## Prefetch Integration

Prefetch pages for SEO:

```typescript
// functions/src/page.ts
import { onPrefetch } from './prefetch'

onPrefetch(async (req, res, url, options) => {
  // Extract page path from URL
  const path = url.pathname.slice(1) || 'home'
  
  // Fetch page data
  const page = await getDoc(req, res, `page/path=${path}`)
  
  if (page) {
    options.title = page.title
    options.description = extractDescription(page.content)
  }
  
  return { page }
})
```

Client receives prefetched page:

```typescript
import { prefetched } from './prefetched'

if (prefetched.page) {
  xinPage({ page: { source: prefetched.page.content } })
}
```

## Security Considerations

### XSS Prevention

The component uses `bindUnsafeHTML`, which is vulnerable to XSS attacks.

**Safe:** Admin-created content stored in Firestore

```typescript
// Admin creates page in editor
const page = await fb.service.page['about'].get()
xinPage({ page: { source: page.content } }) // Safe - admin content
```

**Unsafe:** User-generated content

```typescript
// DON'T DO THIS
const userComment = getUserInput()
xinPage({ page: { source: userComment } }) // DANGEROUS!
```

**Solution:** Sanitize user content or use text binding:

```typescript
import { sanitizeHtml } from 'some-sanitizer'

const safeContent = sanitizeHtml(userComment)
xinPage({ page: { source: safeContent } })
```

### Content Validation

Validate pages server-side:

```typescript
validate: async (page) => {
  // Strip dangerous tags
  page.content = page.content.replace(/<script/gi, '&lt;script')
  
  // Limit size
  if (page.content.length > 100000) {
    return new Error('Content too large')
  }
  
  return page
}
```

## Advanced Usage

### Template System

Create reusable templates:

```typescript
const template = (content: string) => `
  <div class="page-template">
    <aside class="sidebar">
      <xin-page-nav></xin-page-nav>
    </aside>
    <main>
      ${content}
    </main>
  </div>
`

xinPage({ 
  page: { 
    source: template('<h1>Page Content</h1>') 
  } 
})
```

### Lazy Loading

Load pages on-demand:

```typescript
async function loadPage(path: string) {
  const loading = xinPage({ 
    page: { source: '<div class="spinner">Loading...</div>' } 
  })
  
  const page = await fb.service.page[`page/path=${path}`].get()
  
  xinPage({ page: { source: page.content, title: page.title } })
}
```

### Page Hierarchy

Implement nested pages:

```typescript
// Parent page
{
  path: 'docs',
  title: 'Documentation',
  content: '<h1>Docs</h1>'
}

// Child pages
{
  path: 'docs/getting-started',
  parent: 'docs',
  title: 'Getting Started',
  content: '<h1>Getting Started</h1>'
}
```

Build navigation:

```typescript
const pages = await fb.service.page.get()
const tree = buildTree(pages)

function buildTree(pages) {
  const roots = pages.filter(p => !p.parent)
  return roots.map(root => ({
    ...root,
    children: pages.filter(p => p.parent === root.id)
  }))
}
```

## Further Reading

- [src/page.ts](../src/page.ts) - Page component implementation
- [BLOG_COMPONENT.md](./BLOG_COMPONENT.md) - Blog component (similar pattern)
- [PREFETCH.md](./PREFETCH.md) - SEO and prefetch
