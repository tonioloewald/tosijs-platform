# Blog Component

The built-in blog component (`src/blog.ts`) provides a complete blog system with editing, publishing, and SEO features.

## Features

- 📝 Markdown and HTML editing
- 🖼️ Image uploads via asset manager
- 🔗 SEO-friendly URLs with date-based paths
- 📱 Responsive layout
- 🌙 Dark mode support
- 🔒 Role-based editing permissions
- ⚡ Prefetch for fast loading
- 🔍 Featured image extraction

## Collection Definition

The blog uses a `post` collection defined in `functions/src/blog.ts`:

```typescript
COLLECTIONS.post = {
  unique: ['path'],
  validate: async (post) => {
    // Validation logic
    if (!post.content?.trim()) {
      return new Error('Post content is required')
    }
    return post
  },
  access: {
    [ROLES.public]: {
      read: async (post) => {
        // Only show published posts (those with a date)
        if (!post.date) {
          return new Error('Post not published')
        }
        return post
      },
      list: async (post) => post.date ? post : undefined,
    },
    [ROLES.author]: {
      read: ALL,
      write: ALL,
      list: ALL,
    },
  },
}
```

### Post Document Structure

```typescript
interface Post {
  id: string              // Auto-generated document ID
  title: string           // Post title
  path: string            // URL path (e.g., "my-first-post")
  content: string         // Markdown or HTML content
  format: 'markdown' | 'html'  // Content format
  date?: string           // ISO date (presence = published)
  author: string          // User ID of author
  summary?: string        // Short description
  keywords?: string[]     // Tags/keywords
  imageUrl?: string       // Featured image URL
}
```

## URL Structure

Posts are accessible via date-based URLs:

```
/blog/2025/12/25/my-post-title
```

Or via query parameter:

```
/?p=post/path=my-post-title
```

The `postPathFromLocation()` function extracts the post path from the current URL.

## Component Usage

The blog component is a web component registered as `<xin-blog>`:

```html
<xin-blog></xin-blog>
```

It's typically loaded via the page component:

```typescript
xinPage({ page: { source: '<xin-blog></xin-blog>' } })
```

## Component Parts

The blog component has several interactive parts accessible via `this.parts`:

### `content` - Post Display

The main content area showing the current post or post list.

### `editor` - Edit Dialog

Dialog for creating/editing posts. Includes:
- Title input
- Path input (auto-generated from title)
- Content textarea (Markdown/HTML)
- Format selector
- Asset manager for uploads
- Preview button
- Publish/Save buttons

### `assetManager` - File Uploads

Embedded asset manager for uploading images to Cloud Storage.

## State Management

The component uses tosijs for reactive state:

```typescript
const { blog } = tosi({
  blog: {
    currentPost: {
      id: null,
      title: '',
      content: '',
      // ...
    },
    latestPosts: [],
    recentPosts: [],
  }
})
```

State updates automatically trigger UI re-renders.

## Key Methods

### `loadPost(path: string)`

Load a post by path:

```typescript
blog.loadPost('post/path=my-post')
```

### `editPost(post?: Post)`

Open the editor:

```typescript
// Create new post
blog.editPost()

// Edit existing post
blog.editPost(currentPost)
```

### `savePost()`

Save the current post:

```typescript
await blog.savePost()
```

If `post.date` is set, the post is published.

### `deletePost(id: string)`

Delete a post:

```typescript
await blog.deletePost(postId)
```

### `onLinkClick(event: MouseEvent)`

Handle internal link clicks for SPA navigation:

```typescript
// Attached to click events on post content
blog.onLinkClick(event)
```

## Prefetch Integration

The blog uses server-side prefetch to improve performance and SEO.

In `functions/src/blog.ts`:

```typescript
onPrefetch(async (req, res, url, options) => {
  // Fetch latest posts for homepage
  const latestPosts = await getDocs(req, res, 'post', 6, false, 'date(desc)')
  
  // Fetch recent posts for sidebar
  const recentPosts = await getDocs(
    req, res, 
    'post', 
    30, 
    ['title', 'date', 'path'], 
    'date(desc)'
  )
  
  // If viewing a specific post, fetch it
  let currentPost = null
  const match = url.pathname.match(/\/blog\/(\d{4})\/(\d{2})\/(\d{2})\/(.+)/)
  if (match) {
    const path = match[4]
    currentPost = await getDoc(req, res, `post/path=${path}`)
  }
  
  return {
    latestPosts,
    recentPosts,
    currentPost,
  }
})
```

Client accesses prefetched data:

```typescript
import { prefetched } from './prefetched'

blog.latestPosts = prefetched.latestPosts || []
blog.currentPost = prefetched.currentPost || {}
```

## Caching

Blog data is cached on the server for 1 hour:

```typescript
const BLOG_CACHE_DURATION = 3600 * 1000 // 1 hour

if (
  blogData.latestPosts.length === 0 ||
  Date.now() - blogData.blogDataTimestamp > BLOG_CACHE_DURATION
) {
  // Refresh cache
  blogData = await fetchLatestPosts()
}
```

## SEO Features

### Meta Tags

The prefetch function updates meta tags for each post:

```typescript
options.title = `${post.title} | ${project.name}`
options.description = post.summary || extractSummary(post.content)
options.image = post.imageUrl || extractFirstImage(post.content)
```

### Sitemap

Posts are included in the generated sitemap:

```typescript
// In functions/src/sitemap.ts
const posts = await getDocs(req, res, 'post', false, ['path', 'date'])
posts.forEach(post => {
  sitemap.push({
    url: `${baseUrl}/blog/${formatDate(post.date)}/${post.path}`,
    lastmod: post.date,
    changefreq: 'monthly',
  })
})
```

## Featured Images

The blog automatically extracts the first image from post content:

```typescript
function extractFirstImage(content: string): string | null {
  const imgMatch = content.match(/<img[^>]+src="([^"]+)"/)
  if (imgMatch) return imgMatch[1]
  
  const mdMatch = content.match(/!\[.*?\]\((.*?)\)/)
  if (mdMatch) return mdMatch[1]
  
  return null
}
```

## Editing Flow

1. User clicks "New Post" or "Edit" button
2. `editPost()` opens dialog with asset manager
3. User writes content in Markdown or HTML
4. User uploads images via asset manager
5. Asset URLs are inserted into content
6. User clicks "Publish" (sets date) or "Save Draft"
7. `savePost()` validates and saves via REST API
8. Post appears immediately (or on refresh for new posts)

## Customization

### Change URL Pattern

Edit `postPathFromLocation()` to use different URL structure:

```typescript
// Current: /blog/YYYY/MM/DD/slug
// Custom: /posts/slug

postPathFromLocation() {
  const match = location.pathname.match(/^\/posts\/(.+)$/)
  return match ? `post/path=${match[1]}` : null
}
```

Update prefetch and sitemap accordingly.

### Change Post Collection

1. Update collection name in `COLLECTIONS`
2. Update client code references to `fb.service.post`
3. Update prefetch queries

### Custom Fields

Add fields to the post interface:

```typescript
// In validation
validate: async (post) => {
  post.readingTime = calculateReadingTime(post.content)
  post.category = post.category || 'uncategorized'
  return post
}
```

Update editor UI to include new fields.

### Styling

The blog inherits from the global theme in `src/style.ts`.

Override specific styles:

```typescript
const blogStyles = css`
  .blog-post {
    max-width: 800px;
    margin: 0 auto;
  }
  
  .blog-post h1 {
    font-size: 2.5rem;
    color: var(--text-color);
  }
`
```

## Markdown Rendering

Posts use the `marked` library for Markdown:

```typescript
import { marked } from 'marked'

const html = marked(post.content)
```

Configure marked options in `functions/package.json` dependencies or create a custom renderer.

## Asset Management

Images are uploaded to Firebase Cloud Storage:

```
/blog/{filename}
```

Storage rules (in `storage.rules`):

```
match /blog/{filename} {
  allow read: if true;
  allow write: if request.auth != null;
}
```

The asset manager component handles:
- File selection
- Upload progress
- URL generation
- Insertion into content

## Performance Tips

1. **Limit post queries** - Don't load all posts at once
2. **Use field filtering** - Only fetch needed fields for lists
3. **Enable caching** - Server-side cache reduces Firestore reads
4. **Lazy load images** - Use loading="lazy" on images
5. **Prefetch data** - SSR prefetch reduces client queries

## Example: Adding Categories

1. **Update collection:**

```typescript
// functions/src/blog.ts
COLLECTIONS.post = {
  validate: async (post) => {
    post.category = post.category || 'general'
    return post
  },
  // ... rest of config
}
```

2. **Update editor:**

```typescript
// src/blog.ts
content() {
  return div(
    label('Category'),
    select(
      { bindValue: 'blog.currentPost.category' },
      option({ value: 'general' }, 'General'),
      option({ value: 'tech' }, 'Technology'),
      option({ value: 'design' }, 'Design'),
    ),
    // ... rest of editor
  )
}
```

3. **Add category pages:**

```typescript
loadCategory(category: string) {
  const categoryPosts = prefetched.latestPosts.filter(
    p => p.category === category
  )
  blog.currentPosts = categoryPosts
}
```

## Further Reading

- [functions/src/blog.ts](../functions/src/blog.ts) - Server-side blog logic
- [src/blog.ts](../src/blog.ts) - Client-side blog component
- [FIRESTORE_API.md](./FIRESTORE_API.md) - REST API documentation
- [PREFETCH.md](./PREFETCH.md) - Prefetch and SEO
