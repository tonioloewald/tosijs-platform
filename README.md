# tosijs-platform

## The Problem

Developer experience has been in freefall since the late 1990s.

In the REALbasic era, you could build an app, package it, and distribute it in a day. With PHP/LAMP, you could download a project, copy it to a server, edit a config file, and have a working app in an hour.

Then Node.js became the "standard stack" and standing up "hello world" became a nightmare of tooling, configuration, and dependencies. Platforms like Heroku helped, but we're still miles behind where we were with WordPress - let alone RAD tools from the 90s.

**tosijs-platform brings back that simplicity** - but with a modern stack.

## The Solution

1. Install [Bun](https://bun.sh) if you haven't: `curl -fsSL https://bun.sh/install | bash`
2. Set up a Google developer account
3. Run `bunx create-tosijs-platform-app my-site`
4. Follow the prompts
5. You have a working, production-ready website

> **Note**: You can use `npx` instead of `bunx`, but some utility scripts are TypeScript and may need transpiling if you're not using Bun.

The database is configured. Permissions are set up. Authentication works. You can use it as-is, or customize it *without ever deploying code* - using the `/esm` endpoint and `<tosi-esm>` component to load and run modules dynamically.

**tosijs-platform** is built on [tosijs](https://tosijs.net), which distills 30 years of UI development lessons into one small library. It eliminates the need for most state management and binding code (typically 75%+ of a React app) through automatic binding conventions - patterns that made 90s RAD tools even more productive - while keeping your business logic free of framework dependencies.

## What You Get

- **Firebase backend** - Firestore, Auth, Storage, Cloud Functions
- **Built-in CMS** - blog, pages, custom content types
- **Fine-grained access control** - RBAC with field-level permissions
- **SEO-friendly SSR** - server-side rendering with prefetch
- **Type-safe** - TypeScript throughout
- **Extend without deploying** - dynamic ES modules via `/esm` endpoint

## Quick Start

```bash
bunx create-tosijs-platform-app my-awesome-site
```

The CLI will:
1. ✓ Check Firebase CLI is installed and you're logged in
2. ✓ Ask for your Firebase project ID and admin email
3. ✓ Clone and configure the template
4. ✓ Install dependencies
5. ✓ Generate setup scripts

Then follow the printed instructions to deploy!

## Architecture: TypeScript Access Control

**tosijs-platform** uses a fundamentally different security model than typical Firebase apps:

| Traditional Firebase | tosijs-platform |
|---------------------|-----------------|
| Security rules in Google's DSL | Access control in TypeScript |
| Limited to document/collection level | **Field-level granularity** |
| Basic auth checks | **Full RBAC with 6 roles** |
| Rules separate from app logic | Access logic alongside validation |
| Hard to test | **Fully unit-testable** |

**How it works:**
- All data access goes through Cloud Functions (`/doc`, `/docs` endpoints)
- Access control is defined in TypeScript per-collection (see `functions/src/collections/`)
- Roles: `public` → `author` → `editor` → `admin` → `developer` → `owner`
- Each role can have different read/write/list permissions, down to individual fields
- Server-side validation with `tosijs-schema`

**Example access configuration:**
```typescript
access: {
  [ROLES.public]: {
    read: ALL,           // Anyone can read
    list: ALL,           // Anyone can list
  },
  [ROLES.author]: {
    write: ['title', 'body', 'tags'],  // Authors can edit these fields
  },
  [ROLES.admin]: {
    write: ALL,          // Admins can edit everything
    delete: true,        // Admins can delete
  },
}
```

> **Important**: Cloud Functions deployment is **required** for the platform to work. The Firestore rules file (`firestore.rules`) uses deny-all defaults because all access is mediated through the Functions layer.

See [Firestore REST API & Security](docs/FIRESTORE_API.md) for complete documentation.

## Documentation

📚 **Core Concepts:**
- [Firestore REST API & Security](docs/FIRESTORE_API.md) - `/doc`, `/docs` endpoints and role-based access
- [ES Modules](docs/ESM_MODULES.md) - `/esm` endpoint and `<tosi-esm>` component for dynamic code loading
- [Prefetch & SEO](docs/PREFETCH.md) - Server-side rendering for fast loads and search engines

🧩 **Components:**
- [Blog Component](docs/BLOG_COMPONENT.md) - Full-featured blog with Markdown editing
- [Page Component](docs/PAGE_COMPONENT.md) - Generic HTML/component renderer

## Features

### Content Management
- **Built-in blog** with Markdown/HTML editing
- **Static pages** for about, contact, etc.
- **Media library** with image uploads to Cloud Storage
- **Easy to extend** - add custom content types by defining collections

### Developer Experience
- **Hot reload** dev server with HTTPS (uses self-signed TLS certs)
- **Type-safe** APIs and components
- **REST-based** data access (no SDK lock-in)
- **Flexible development** - work against production Firebase or use emulators

### Security & Access Control
- **Role-based access** (public, author, editor, admin, developer, owner)
- **Per-collection rules** with validation
- **Field-level permissions**
- **Server-side validation**

### Performance
- **Client-side rendering** with prefetch for SEO
- **Caching** (configurable per content type)
- **Optimized builds** with Bun
- **CDN-ready** static hosting

## Tech Stack

- **Frontend**: [tosijs](https://tosijs.net) + [tosijs-ui](https://ui.tosijs.net)
- **Build**: [Bun](https://bun.sh/) for lightning-fast builds
- **Backend**: [Firebase](https://firebase.google.com/) (Functions, Firestore, Auth, Storage)
- **Language**: TypeScript throughout

## Why Blaze Plan is Required

tosijs-platform uses **Cloud Functions** to provide a secure REST API for Firestore access. This approach:
- ✅ **Minimizes client bundle size** (no Firestore SDK in browser)
- ✅ **Centralized security** (validation and access control on server)
- ✅ **Fine-grained permissions** (role-based access, field-level filtering)

However, Cloud Functions are **only available on Firebase Blaze plan** (pay-as-you-go).

**Good news:** Blaze plan includes a generous free tier:
- 2M function invocations/month
- 5GB storage
- 10GB hosting transfer

Most small-to-medium sites stay **completely free** within these limits. You only pay for what you use beyond the free tier.

## Prerequisites

1. **Bun** - Install from [bun.sh](https://bun.sh)
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **Firebase CLI** - For deployment
   ```bash
   npm install -g firebase-tools
   firebase login
   ```

3. **Firebase Project with Blaze Plan** - Create at [console.firebase.google.com](https://console.firebase.google.com)
   - **REQUIRED: Blaze plan** (pay-as-you-go)
   - tosijs-platform uses Cloud Functions for secure REST API access
   - Free tier does NOT support Cloud Functions - the platform will not work without Blaze
   - Blaze includes generous free tier: 2M function invocations/month, 5GB storage
   - Most small sites stay within free limits
   - Note your **Project ID**

## Installation & Setup

### Step 1: Create Project

```bash
bunx create-tosijs-platform-app my-site
```

You'll be prompted for:
- **Firebase Project ID**: Your Firebase project ID (from console)
- **Admin Email**: Your Google account email (for owner access)
- **Site Name**: Display name for your site
- **Site Description**: Meta description

### Step 2: Get Firebase Config

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project
3. Go to **Project Settings** → **General**
4. Scroll to **Your apps** → Add a web app (or use existing)
5. Copy the config object

### Step 3: Update Configuration

Edit `src/firebase-config.ts` with your Firebase config:

```typescript
const PROJECT_ID = 'your-project-id'

export const config = {
  authDomain: `${PROJECT_ID}.firebaseapp.com`,
  projectId: PROJECT_ID,
  storageBucket: `${PROJECT_ID}.appspot.com`,
  apiKey: 'YOUR_API_KEY',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
  measurementId: 'YOUR_MEASUREMENT_ID',
}
```

### Step 4: Enable Firebase Services

In Firebase Console, enable:

1. **Authentication** → Sign-in method → Google (enable)
2. **Firestore Database** → Create database (production mode)
3. **Storage** → Get started
4. **Functions** → (automatically enabled with Blaze plan)

### Step 5: Deploy Functions

```bash
cd my-site
bun deploy-functions
```

Wait for deployment to complete (~2-5 minutes).

### Step 6: Initialize Admin User

After functions are deployed, run the setup script:

```bash
bun setup.js
```

This creates:
- Owner role for your admin email
- Welcome post to get started

### Step 7: Start Development

```bash
bun start
```

Visit **https://localhost:8020** and sign in with your admin email.

> **Note:** Your browser will warn about the self-signed certificate - this is expected. Click through to proceed.

#### Why HTTPS for Local Development?

Unlike typical Firebase setups that use HTTP emulators, tosijs-platform uses a custom HTTPS dev server that connects directly to your production Firebase backend. This approach:

- **Simplifies development** - no emulator setup or management
- **Matches production** - test against real data and auth
- **Enables secure cookies** - Firebase Auth requires HTTPS
- **Faster startup** - just `bun start`, no emulator spin-up

The TLS certificates in `tls/` are generated automatically by `create-tosijs-platform-app`, or you can regenerate them with `./tls/create-dev-certs.sh`.

### Step 8: Deploy Hosting

When ready to go live:

```bash
bun deploy-hosting
```

Your site will be live at `https://your-project-id.web.app`

## Project Structure

```
my-site/
├── src/                    # Client-side code
│   ├── index.ts           # App entry point
│   ├── app.ts             # Global state
│   ├── blog.ts            # Blog component
│   ├── firebase.ts        # Firebase client wrapper
│   ├── tosi-esm.ts        # Dynamic ES module loader component
│   └── style.ts           # Theme & styling
├── functions/             # Cloud Functions
│   ├── src/
│   │   ├── index.ts       # Function exports
│   │   ├── doc.ts         # Document CRUD API
│   │   ├── docs.ts        # Collection query API
│   │   ├── esm.ts         # ES module serving endpoint
│   │   ├── gen.ts         # LLM generation endpoint
│   │   ├── prefetch.ts    # SSR prefetch endpoint
│   │   ├── blog.ts        # Blog collection config
│   │   ├── module.ts      # Module collection config
│   │   ├── access.ts      # Access control system
│   │   ├── elements.ts    # Server-side HTML rendering
│   │   └── roles.ts       # Role definitions
│   └── shared/            # Shared TypeScript types
│       ├── module.ts      # Module interface
│       └── page.ts        # Page interface
├── initial_state/         # Seed data for Firestore
│   └── firestore/
│       ├── page.json      # Initial pages
│       └── module.json    # Initial modules
├── public/                # Static assets
│   ├── index.html
│   └── logo.svg
├── firebase.json          # Firebase config
├── firestore.rules        # Security rules
├── storage.rules          # Storage security
└── dev.ts                 # Dev server
```

## Adding Custom Content Types

Define new content types by adding to `COLLECTIONS` in `functions/src/`:

```typescript
// functions/src/products.ts
import { COLLECTIONS } from './collections'
import { ROLES } from './roles'
import { ALL } from './access'

COLLECTIONS.product = {
  unique: ['sku'],
  validate: async (data) => {
    if (!data.name || !data.price) {
      return new Error('Name and price required')
    }
    return data
  },
  access: {
    [ROLES.public]: {
      read: ALL,
      list: ALL,
    },
    [ROLES.admin]: {
      write: ALL,
    }
  }
}
```

Then import in `functions/src/index.ts`:

```typescript
import './products'
```

## Customization

### Theme

Edit `src/style.ts` to customize colors, fonts, spacing:

```typescript
export const theme = tosi({
  mode: 'light', // 'light' | 'dark' | 'system'
  colors: {
    primary: '#007acc',
    // ... more colors
  }
})
```

### Content Collections

Each content type (blog posts, pages, etc.) is defined in `functions/src/` as a collection config with:
- **Validation** rules
- **Unique** field constraints  
- **Access control** per role
- **Field-level** permissions

See `functions/src/blog.ts` for a complete example.

### UI Components

Create custom components using tosijs:

```typescript
import { elements, Component } from 'tosijs'

export class MyComponent extends Component {
  content = () => {
    const { div, h1 } = elements
    return div(
      h1('Hello World')
    )
  }
}
```

### Custom Endpoints

Create custom Cloud Function endpoints. See `functions/src/hello.ts` for a minimal example:

```typescript
import { onRequest } from 'firebase-functions/v2/https'
import compression from 'compression'
import { optionsResponse, getUserRoles } from './utilities'

const compressResponse = compression()

export const myEndpoint = onRequest({}, async (req, res) => {
  // Handle CORS preflight
  if (optionsResponse(req, res)) {
    return
  }
  
  // Get authenticated user's roles
  const userRoles = await getUserRoles(req)
  
  // Your logic here
  compressResponse(req, res, () => {
    res.json({ message: 'Hello!', roles: userRoles.roles })
  })
})
```

Then export in `functions/src/index.ts`:

```typescript
export { myEndpoint } from './my-endpoint'
```

For endpoints using secrets (API keys), see `functions/src/gen.ts` which demonstrates the `defineSecret` pattern.

## Development Commands

```bash
bun start              # Start dev server (https://localhost:8020)
bun start-emulated     # Start with Firebase emulators
bun seed               # Seed emulators with initial_state data
bun seed-clear         # Clear emulators and reseed
bun deploy-functions   # Deploy Cloud Functions
bun deploy-hosting     # Deploy static hosting
bun format             # Format code with Prettier
bun latest             # Update all dependencies
```

### Using Emulators

For isolated development without affecting production data:

```bash
# Start emulators and dev server
bun start-emulated

# In another terminal, seed with initial data
bun seed
```

The emulators provide local Firestore, Auth, Storage, and Functions. Data is seeded from `initial_state/firestore/`.

## Secrets Management

For API keys (e.g., Gemini, OpenAI, Stripe), use Firebase Secret Manager (required for v2 functions):

```bash
firebase functions:secrets:set OPENAI_API_KEY
```

Access in functions:

```typescript
import { defineSecret } from 'firebase-functions/params'

const openaiKey = defineSecret('OPENAI_API_KEY')

export const myFunction = onRequest(
  { secrets: [openaiKey] },
  async (req, res) => {
    const key = openaiKey.value()
    // use key...
  }
)
```

## User Management

Users are managed via the `user` collection in Firestore. Roles are assigned per user:

```typescript
// In Firestore console or via code:
collection('user').doc(userId).set({
  email: 'user@example.com',
  roles: ['author'], // 'public', 'author', 'editor', 'admin', 'developer', 'owner'
})
```

## Deployment Checklist

- [ ] Firebase config updated in `src/firebase-config.ts`
- [ ] Google Auth enabled in Firebase Console
- [ ] Firestore Database created
- [ ] Cloud Storage enabled
- [ ] Functions deployed (`bun deploy-functions`)
- [ ] Admin user created (`bun setup.js`)
- [ ] Local dev working (`bun start`)
- [ ] Hosting deployed (`bun deploy-hosting`)
- [ ] Custom domain configured (optional)

## Troubleshooting

### "Firebase CLI not found"
```bash
npm install -g firebase-tools
```

### "Not logged in to Firebase"
```bash
firebase login
```

### "Functions deployment failed"
- Check Firebase project has Blaze plan enabled
- Verify `.firebaserc` has correct project ID

### "Permission denied" errors
- Make sure admin user exists in `user` collection
- Check `roles` array includes 'owner' or 'admin'

### "CORS errors" in development
- The dev server uses HTTPS (required for Firebase)
- Accept the self-signed certificate in your browser

## Performance Tips

1. **Limit Firestore reads**: Use caching and prefetch
2. **Optimize images**: Compress before uploading
3. **Use Cloud CDN**: Firebase Hosting includes CDN
4. **Monitor costs**: Check Firebase usage dashboard

## Contributing

Issues and PRs welcome at [github.com/tonioloewald/tosijs-platform](https://github.com/tonioloewald/tosijs-platform)

## License

MIT © Tonio Loewald

## Learn More

- [tosijs Documentation](https://tosijs.net) - State management and components (includes AI context)
- [tosijs-ui Components](https://ui.tosijs.net) - UI component library with live examples
- [Firebase Documentation](https://firebase.google.com/docs)
- [Bun Documentation](https://bun.sh/docs)

## Platform Documentation

- **[Firestore REST API & Security](docs/FIRESTORE_API.md)** - How the REST endpoints work, access control, validation
- **[ES Modules](docs/ESM_MODULES.md)** - Dynamic code loading via `/esm` endpoint
- **[LLM Generation](docs/GEN_ENDPOINT.md)** - `/gen` endpoint for Gemini/ChatGPT text generation
- **[Blog Component](docs/BLOG_COMPONENT.md)** - Built-in blog system, editing, publishing
- **[Page Component](docs/PAGE_COMPONENT.md)** - Generic content renderer, static pages
- **[Prefetch & SEO](docs/PREFETCH.md)** - Server-side rendering, meta tags, social media previews
