# Firestore REST API & Security

tosijs-platform provides a secure REST API for Firestore access through Cloud Functions. This approach keeps your client bundle small and centralizes security logic on the server.

## Why REST Instead of Firestore SDK?

**Traditional Approach (Firestore SDK in browser):**
- ❌ Large bundle size (~300KB+ for Firebase SDK)
- ❌ Security rules in separate `.rules` file
- ❌ Limited validation capabilities
- ❌ Hard to implement field-level permissions

**tosijs-platform Approach (REST API via Cloud Functions):**
- ✅ Tiny client code (just fetch calls)
- ✅ Server-side validation and transformation
- ✅ Fine-grained access control (role-based, field-level)
- ✅ TypeScript throughout
- ✅ Easy to test and debug

## Endpoints

### `/doc` - Single Document Operations

CRUD operations for individual documents.

#### GET - Read Document

```typescript
// Client code
const post = await fb.service.post['post-id'].get()

// Equivalent to
GET /doc/post/post-id
Authorization: Bearer <firebase-id-token>
```

**Access Control:**
1. Checks user roles
2. Finds highest role with `read` permission
3. Applies read filter (field masking, transformation)
4. Returns filtered document or error

#### POST - Create Document

```typescript
// Client code
const newPost = await fb.service.post.post({
  title: 'My Post',
  content: 'Hello world',
})

// Equivalent to
POST /doc/post
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "title": "My Post",
  "content": "Hello world"
}
```

**Processing:**
1. Validates data via collection's `validate()` function
2. Checks unique field constraints
3. Verifies user has `write` permission
4. Creates document with auto-generated ID
5. Returns created document

#### PUT - Replace Document

```typescript
// Client code
await fb.service.post['post-id'].put({
  title: 'Updated Title',
  content: 'New content',
})

// Equivalent to
PUT /doc/post/post-id
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "title": "Updated Title",
  "content": "New content"
}
```

**Processing:**
1. Validates new data
2. Checks unique constraints (excluding current doc)
3. Verifies write permission
4. Replaces entire document
5. Returns updated document

#### PATCH - Update Document

```typescript
// Client code
await fb.service.post['post-id'].patch({
  title: 'Just update the title',
})

// Equivalent to
PATCH /doc/post/post-id
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "title": "Just update the title"
}
```

**Processing:**
1. Fetches existing document
2. Merges with provided fields
3. Validates merged data
4. Checks unique constraints
5. Updates document
6. Returns updated document

#### DELETE - Delete Document

```typescript
// Client code
await fb.service.post['post-id'].delete()

// Equivalent to
DELETE /doc/post/post-id
Authorization: Bearer <firebase-id-token>
```

**Processing:**
1. Verifies write permission
2. Deletes document
3. Returns success

### `/docs` - Collection Queries

Query and list documents from a collection.

#### GET - List Documents

```typescript
// Client code
const posts = await fb.service.post.get()

// With limit
const latest = await fb.service.post.get(10)

// With specific fields
const titles = await fb.service.post.get(10, ['title', 'date'])

// With sorting
const byDate = await fb.service.post.get(10, false, 'date(desc)')

// Equivalent to
GET /docs/post?limit=10&fields=title,date&sort=date(desc)
Authorization: Bearer <firebase-id-token>
```

**Parameters:**
- `limit` - Maximum number of documents (default: 100)
- `fields` - Array of field names or `false` for all fields
- `sort` - Sort expression: `field(asc)` or `field(desc)`

**Processing:**
1. Checks `list` permission for user's role
2. Applies list filter to each document
3. Filters out documents that return errors
4. Applies field filtering if specified
5. Sorts results
6. Returns array of documents

### `/user` - Current User Info

Get current user's roles and permissions.

```typescript
// Client code
const user = await fb.service.user.get()

// Returns
{
  uid: 'user-id',
  email: 'user@example.com',
  roles: ['author', 'editor']
}
```

## Security Model

### Collection Configuration

Collections are defined in `functions/src/` with security and validation rules:

```typescript
import { COLLECTIONS } from './collections'
import { ROLES } from './roles'
import { ALL } from './access'

COLLECTIONS.post = {
  // Unique field constraints
  unique: ['path', 'title'],
  
  // Server-side validation
  validate: async (data, userRoles) => {
    if (!data.title?.trim()) {
      return new Error('Title is required')
    }
    
    // Transform data
    data.slug = data.title.toLowerCase().replace(/\s+/g, '-')
    
    return data
  },
  
  // Role-based access control
  access: {
    [ROLES.public]: {
      // Public can read published posts only
      read: async (post) => {
        if (!post.date) {
          return new Error('Not published')
        }
        // Hide author's email
        delete post.authorEmail
        return post
      },
      // Public can see published posts in lists
      list: async (post) => {
        return post.date ? post : undefined
      },
    },
    
    [ROLES.author]: {
      // Authors can read all posts
      read: ALL,
      // Authors can see all posts
      list: ALL,
      // Authors can create/edit their own posts
      write: async (post, userRoles, userId) => {
        if (post.author === userId) {
          return post
        }
        return new Error('Can only edit own posts')
      },
    },
    
    [ROLES.admin]: {
      // Admins have full access
      read: ALL,
      write: ALL,
      list: ALL,
    },
  },
}
```

### Built-in Roles

Defined in `functions/src/roles.ts`:

```typescript
export const ROLES = {
  public: 'public',      // Unauthenticated users
  author: 'author',      // Can create content
  editor: 'editor',      // Can edit others' content
  admin: 'admin',        // Can manage users and content
  developer: 'developer', // Can access technical features
  owner: 'owner',        // Full access
}
```

Roles are hierarchical - access rules are checked in order from most restrictive to least restrictive.

### Access Configuration Options

#### 1. `ALL` - Full Access

```typescript
read: ALL  // Any user with this role can read
```

#### 2. Field Map - Restrict Fields

```typescript
read: {
  title: true,
  content: true,
  author: true,
  // authorEmail is hidden
}
```

#### 3. Function - Dynamic Access

```typescript
read: async (doc, userRoles, userId) => {
  // Return modified doc
  if (doc.isPrivate && doc.author !== userId) {
    return new Error('Access denied')
  }
  
  delete doc.internalNotes
  return doc
}

// For list operations
list: async (doc, userRoles, userId) => {
  // Return doc to include in list
  // Return undefined to exclude
  // Return Error to exclude silently
  
  if (doc.isPublished) {
    return doc
  }
  return undefined
}
```

### Validation Function

The `validate` function runs before any write operation:

```typescript
validate: async (data, userRoles) => {
  // Check required fields
  if (!data.name) {
    return new Error('Name is required')
  }
  
  // Transform data
  data.slug = slugify(data.name)
  data.updatedAt = new Date().toISOString()
  
  // Prevent privilege escalation
  if (data.role === 'owner' && !userRoles.includes('owner')) {
    return new Error('Cannot create owner users')
  }
  
  // Return modified data
  return data
}
```

### Unique Constraints

Enforce uniqueness across the collection:

```typescript
COLLECTIONS.user = {
  unique: ['email', 'username'],
  // ...
}
```

Unique checks:
- Run after validation
- Case-sensitive
- Checked on POST, PUT, PATCH
- Exclude current document on updates

### Document Caching

For frequently-read, rarely-changing documents (like configuration), enable TTL caching:

```typescript
COLLECTIONS.config = {
  cacheLatencySeconds: 300, // Cache for 5 minutes
  access: {
    [ROLES.public]: {
      read: ALL,
      list: ALL,
    },
    // ...
  },
}
```

**How it works:**
- Documents are cached in memory after the first read
- Subsequent reads return cached data until TTL expires
- Cache is per Cloud Function instance
- Cache clears on cold starts (new instances)

**When to use:**
- Configuration documents that change rarely
- Settings that can tolerate 1-5 minutes of staleness
- High-traffic reads where Firestore latency matters

**When NOT to use:**
- User-specific data
- Frequently updated documents
- Data where freshness is critical

**Example savings:**
- Without cache: 10K requests/day × 5ms = ~50 seconds latency, ~$0.06 Firestore costs
- With 5-minute cache: ~288 Firestore reads/day, negligible latency and costs

## Sub-Collections

Define access for nested collections:

```typescript
// Top-level posts
COLLECTIONS.post = { /* ... */ }

// Comments on posts
COLLECTIONS['post/comment'] = {
  access: {
    [ROLES.public]: {
      read: ALL,
      list: ALL,
    },
    [ROLES.author]: {
      write: ALL,
    },
  },
}

// Access as:
// /doc/post/{postId}/comment/{commentId}
// /docs/post/{postId}/comment
```

## Client Usage

The `firebase.ts` client creates a dynamic proxy:

```typescript
// Auto-generates REST calls
fb.service.post.get()                    // GET /docs/post
fb.service.post['123'].get()             // GET /doc/post/123
fb.service.post.post({ title: 'Hi' })   // POST /doc/post
fb.service.post['123'].put({ ... })      // PUT /doc/post/123
fb.service.post['123'].patch({ ... })    // PATCH /doc/post/123
fb.service.post['123'].delete()          // DELETE /doc/post/123

// Sub-collections
fb.service.post['123'].comment.get()     // GET /docs/post/123/comment
```

## Error Handling

Errors are returned as JSON:

```json
{
  "error": "Validation failed: Title is required"
}
```

Client receives rejected promise:

```typescript
try {
  await fb.service.post.post({ content: 'No title' })
} catch (error) {
  console.error(error) // "Validation failed: Title is required"
}
```

## Performance Considerations

### Caching

Use the built-in cache system for expensive queries:

```typescript
import { cachedQuery } from './cached-query'

const result = await cachedQuery(
  'blog-latest',           // Cache key
  60 * 60 * 1000,         // TTL: 1 hour
  async () => {            // Query function
    return await getDocs(req, res, 'post', 10)
  }
)
```

### Pagination

Limit queries to avoid timeouts:

```typescript
// Good: limited query
const posts = await fb.service.post.get(20)

// Bad: unlimited query (can timeout)
const allPosts = await fb.service.post.get(false)
```

### Field Filtering

Request only needed fields:

```typescript
// Good: only get needed fields
const titles = await fb.service.post.get(10, ['title', 'date'])

// Less efficient: get all fields
const posts = await fb.service.post.get(10)
```

## Security Best Practices

1. **Always validate server-side** - Never trust client data
2. **Use validation functions** - Transform and sanitize before storage
3. **Field-level filtering** - Hide sensitive data from unauthorized users
4. **Unique constraints** - Prevent duplicate emails, usernames, etc.
5. **Role hierarchy** - Order access rules from restrictive to permissive
6. **Error messages** - Don't leak sensitive information
7. **Rate limiting** - Consider adding rate limits for production

## Testing Collections

Test your collection configuration:

```typescript
// In functions/src/collections.ts
COLLECTIONS.test = {
  validate: async (data) => {
    if (data.isInvalid) {
      return new Error('Invalid data')
    }
    data.processed = true
    return data
  },
  unique: ['uniqueField'],
  access: {
    [ROLES.public]: {
      read: async (data) => {
        delete data.secret
        return data
      },
      write: ALL,
      list: ALL,
    },
  },
}
```

Then test with your client or curl:

```bash
# Create test document
curl -X POST https://YOUR-PROJECT.cloudfunctions.net/doc/test \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"uniqueField": "test", "secret": "hidden"}'

# Read it back (secret should be removed)
curl https://YOUR-PROJECT.cloudfunctions.net/doc/test/DOCUMENT_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Further Reading

- [functions/src/access.ts](../functions/src/access.ts) - Access control implementation
- [functions/src/doc.ts](../functions/src/doc.ts) - Document endpoint
- [functions/src/docs.ts](../functions/src/docs.ts) - Collection query endpoint
- [functions/src/roles.ts](../functions/src/roles.ts) - Role definitions
