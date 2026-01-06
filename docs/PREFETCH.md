# Prefetch & SEO

tosijs-platform provides server-side prefetching for fast initial loads and SEO-friendly content.

## How It Works

### The Problem

Traditional SPAs have SEO challenges:
- ❌ Search engines see empty HTML
- ❌ Social media can't extract preview data
- ❌ Slow time-to-first-meaningful-paint
- ❌ No content without JavaScript

### The Solution

tosijs-platform uses Cloud Functions to:
1. Intercept all HTTP requests
2. Fetch data from Firestore server-side
3. Inject data and meta tags into HTML
4. Serve enriched HTML to clients
5. Client hydrates with prefetched data

## Architecture

```
User Request
    ↓
Firebase Hosting
    ↓
/prefetch Cloud Function (catch-all)
    ↓
Registered onPrefetch Handlers
    ↓
    • Blog handler fetches posts
    • Page handler fetches page content
    • Custom handlers fetch app data
    ↓
HTML Template with:
    • Meta tags (og:title, og:image, etc.)
    • Prefetched data in window.prefetched
    • Original HTML + JavaScript
    ↓
User / Search Engine
```

## Server-Side: Registering Prefetch Handlers

### Basic Handler

In any Cloud Function file (e.g., `functions/src/blog.ts`):

```typescript
import { onPrefetch } from './prefetch'

onPrefetch(async (req, res, url, options) => {
  // Fetch data
  const posts = await getDocs(req, res, 'post', 10, false, 'date(desc)')
  
  // Return data (will be in window.prefetched)
  return {
    latestPosts: posts
  }
})
```

### Handler with Meta Tags

Update page metadata for SEO:

```typescript
onPrefetch(async (req, res, url, options) => {
  // Check if viewing a specific post
  const postPath = extractPostPath(url.pathname)
  
  if (postPath) {
    const post = await getDoc(req, res, `post/path=${postPath}`)
    
    if (post) {
      // Update meta tags
      options.title = `${post.title} | My Blog`
      options.description = post.summary || extractSummary(post.content)
      options.image = post.imageUrl || extractFirstImage(post.content)
      options.url = `${url.origin}${url.pathname}`
      
      return { currentPost: post }
    }
  }
  
  // Default
  return { currentPost: null }
})
```

### Multiple Handlers

Register multiple handlers for different features:

```typescript
// Blog handler
onPrefetch(async (req, res, url, options) => {
  const posts = await getDocs(req, res, 'post', 10)
  return { latestPosts: posts }
})

// Page handler
onPrefetch(async (req, res, url, options) => {
  const path = url.pathname.slice(1) || 'home'
  const page = await getDoc(req, res, `page/path=${path}`)
  
  if (page) {
    options.title = page.title
  }
  
  return { page }
})

// User handler
onPrefetch(async (req, res, url, options) => {
  const user = await getCurrentUser(req)
  return { user }
})
```

All handlers run concurrently, and their results are merged.

## Prefetch Options

The `options` parameter controls the HTML output:

```typescript
interface PageOptions {
  title?: string           // Document title + og:title
  description?: string     // Meta description + og:description
  image?: string          // og:image
  url?: string            // og:url
  type?: string           // og:type (default: 'website')
  siteName?: string       // og:site_name
}
```

Example:

```typescript
options.title = 'My Amazing Post'
options.description = 'Learn how to build amazing things'
options.image = 'https://example.com/post-image.jpg'
options.url = 'https://example.com/posts/amazing'
options.type = 'article'
```

Generates:

```html
<title>My Amazing Post</title>
<meta name="description" content="Learn how to build amazing things">
<meta property="og:title" content="My Amazing Post">
<meta property="og:description" content="Learn how to build amazing things">
<meta property="og:image" content="https://example.com/post-image.jpg">
<meta property="og:url" content="https://example.com/posts/amazing">
<meta property="og:type" content="article">
```

## Client-Side: Accessing Prefetched Data

### Import Prefetched Helper

```typescript
// src/prefetched.ts
export const prefetched = (window as any).prefetched || {}
```

### Use in Components

```typescript
import { prefetched } from './prefetched'

// Initialize state with prefetched data
const { blog } = tosi({
  blog: {
    latestPosts: prefetched.latestPosts || [],
    currentPost: prefetched.currentPost || null,
  }
})
```

### Fallback to API

If no prefetched data (e.g., client-side navigation):

```typescript
async function loadPosts() {
  if (prefetched.latestPosts) {
    // Use prefetched data
    blog.latestPosts = prefetched.latestPosts
  } else {
    // Fetch from API
    blog.latestPosts = await fb.service.post.get(10)
  }
}
```

## Caching

Implement server-side caching to reduce Firestore reads:

```typescript
let cachedData = {
  posts: [],
  timestamp: 0,
}

const CACHE_TTL = 3600 * 1000 // 1 hour

onPrefetch(async (req, res, url, options) => {
  const now = Date.now()
  
  // Check cache
  if (cachedData.posts.length > 0 && now - cachedData.timestamp < CACHE_TTL) {
    return { latestPosts: cachedData.posts }
  }
  
  // Refresh cache
  const posts = await getDocs(req, res, 'post', 10, false, 'date(desc)')
  cachedData = {
    posts,
    timestamp: now,
  }
  
  return { latestPosts: posts }
})
```

Or use the built-in cache helper:

```typescript
import { cachedQuery } from './cached-query'

onPrefetch(async (req, res, url, options) => {
  const posts = await cachedQuery(
    'latest-posts',       // Cache key
    3600 * 1000,         // TTL
    async () => {
      return await getDocs(req, res, 'post', 10)
    }
  )
  
  return { latestPosts: posts }
})
```

## URL Routing

### Path-Based Routing

Extract data from URL path:

```typescript
onPrefetch(async (req, res, url, options) => {
  // Match: /blog/2025/12/25/my-post
  const match = url.pathname.match(/^\/blog\/(\d{4})\/(\d{2})\/(\d{2})\/(.+)$/)
  
  if (match) {
    const [, year, month, day, slug] = match
    const post = await getDoc(req, res, `post/path=${slug}`)
    
    if (post) {
      options.title = post.title
      return { currentPost: post }
    }
  }
  
  return {}
})
```

### Query Parameter Routing

Extract from query string:

```typescript
onPrefetch(async (req, res, url, options) => {
  // Match: /?p=post/id=123
  const postQuery = url.searchParams.get('p')
  
  if (postQuery) {
    const post = await getDoc(req, res, postQuery)
    if (post) {
      options.title = post.title
      return { currentPost: post }
    }
  }
  
  return {}
})
```

## Performance Optimization

### Parallel Queries

Fetch multiple data sources in parallel:

```typescript
onPrefetch(async (req, res, url, options) => {
  const [latestPosts, featuredPosts, categories] = await Promise.all([
    getDocs(req, res, 'post', 10, false, 'date(desc)'),
    getDocs(req, res, 'post', 5, false, 'featured(desc)'),
    getDocs(req, res, 'category', 20),
  ])
  
  return {
    latestPosts,
    featuredPosts,
    categories,
  }
})
```

### Conditional Fetching

Only fetch what's needed:

```typescript
onPrefetch(async (req, res, url, options) => {
  const result: any = {}
  
  // Always fetch latest posts
  result.latestPosts = await getDocs(req, res, 'post', 10)
  
  // Only fetch post if viewing one
  if (url.pathname.startsWith('/post/')) {
    const slug = url.pathname.split('/').pop()
    result.currentPost = await getDoc(req, res, `post/path=${slug}`)
  }
  
  // Only fetch user if authenticated
  if (req.headers.authorization) {
    result.user = await getCurrentUser(req)
  }
  
  return result
})
```

### Field Limiting

Request only needed fields:

```typescript
const posts = await getDocs(
  req, res,
  'post',
  30,
  ['title', 'date', 'path'], // Only these fields
  'date(desc)'
)
```

## Social Media Previews

### Twitter Cards

```typescript
options.title = post.title
options.description = post.summary
options.image = post.imageUrl
options.type = 'article'
```

Generates both Open Graph and Twitter tags:

```html
<meta property="og:title" content="Post Title">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Post Title">
```

### Custom Meta Tags

For advanced use cases, modify the HTML template directly in `functions/src/prefetch.ts`:

```typescript
let html = Bun.file('public/index.html')

// Add custom meta tags
html = html.replace('</head>', `
  <meta name="twitter:site" content="@myhandle">
  <meta name="twitter:creator" content="@author">
  <meta property="article:published_time" content="${post.date}">
  <meta property="article:author" content="${post.author}">
  </head>
`)
```

## Debugging

### Log Prefetch Data

```typescript
onPrefetch(async (req, res, url, options) => {
  const data = await fetchMyData()
  
  console.log('Prefetch data:', {
    url: url.pathname,
    data,
    options,
  })
  
  return data
})
```

### View Source

Check the HTML source in browser (View → Page Source) to see:

```html
<script id="prefetched-data" type="application/json">
{
  "latestPosts": [...],
  "currentPost": {...}
}
</script>
```

### Client Console

```typescript
console.log('Prefetched:', window.prefetched)
```

## SEO Best Practices

### 1. Always Set Title

```typescript
options.title = post.title || 'My Site'
```

### 2. Provide Descriptions

```typescript
options.description = post.summary || 
  extractFirstParagraph(post.content).slice(0, 160)
```

### 3. Use High-Quality Images

```typescript
// Prefer dedicated social images over content images
options.image = post.socialImage || post.imageUrl || '/default-og.png'
```

### 4. Set Canonical URLs

```typescript
options.url = `${url.origin}${url.pathname}`
```

### 5. Include Structured Data

Add JSON-LD to the HTML:

```typescript
const structuredData = {
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  "headline": post.title,
  "image": post.imageUrl,
  "datePublished": post.date,
  "author": {
    "@type": "Person",
    "name": post.authorName
  }
}

// Inject into HTML
html = html.replace('</head>', `
  <script type="application/ld+json">
    ${JSON.stringify(structuredData)}
  </script>
  </head>
`)
```

## Sitemap Generation

The `sitemap` function generates an XML sitemap:

```typescript
// functions/src/sitemap.ts
export const sitemap = onRequest(async (req, res) => {
  const posts = await getDocs(req, res, 'post', false, ['path', 'date'])
  const pages = await getDocs(req, res, 'page', false, ['path'])
  
  const urls = []
  
  // Add posts
  posts.forEach(post => {
    urls.push({
      loc: `https://example.com/blog/${formatDate(post.date)}/${post.path}`,
      lastmod: post.date,
      changefreq: 'monthly',
      priority: 0.8,
    })
  })
  
  // Add pages
  pages.forEach(page => {
    urls.push({
      loc: `https://example.com/${page.path}`,
      changefreq: 'weekly',
      priority: 0.9,
    })
  })
  
  const xml = generateSitemapXML(urls)
  
  res.setHeader('Content-Type', 'application/xml')
  res.send(xml)
})
```

Access at `https://yoursite.com/sitemap.xml`

Submit to Google Search Console for indexing.

## Testing SEO

### Google's Rich Results Test

https://search.google.com/test/rich-results

Paste your URL to see how Google sees your page.

### Facebook Sharing Debugger

https://developers.facebook.com/tools/debug/

See Open Graph tags and preview.

### Twitter Card Validator

https://cards-dev.twitter.com/validator

Validate Twitter card metadata.

### Lighthouse

Run Lighthouse in Chrome DevTools:
- Performance score
- SEO score
- Best practices
- Accessibility

## Further Reading

- [functions/src/prefetch.ts](../functions/src/prefetch.ts) - Prefetch implementation
- [src/prefetched.ts](../src/prefetched.ts) - Client-side helper
- [FIRESTORE_API.md](./FIRESTORE_API.md) - REST API for data fetching
- [BLOG_COMPONENT.md](./BLOG_COMPONENT.md) - Blog prefetch example
