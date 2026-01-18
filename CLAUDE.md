# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is **tosijs-platform**, a full-stack web application platform built on Firebase and tosijs. It provides a CMS-like system with blog, pages, and custom content types, using Cloud Functions for secure REST API access with role-based access control.

## Development Commands

```bash
bun start              # Dev server at https://localhost:8020 (uses self-signed TLS)
bun start-emulated     # Start with Firebase emulators
bun seed               # Seed emulators with initial_state data
bun seed-clear         # Clear emulators and reseed
bun build              # Build client to dist/
bun format             # Format code with Prettier
bun deploy             # Deploy everything to Firebase
bun deploy-functions   # Deploy Cloud Functions only
bun deploy-hosting     # Deploy static hosting only
```

### Functions development

```bash
cd functions
bun test               # Run tests
bun run build          # Compile TypeScript to lib/
npm run lint           # Lint functions code
```

## Architecture

### Client-Server Split

- **`src/`** - Client-side TypeScript, built with Bun to `dist/`
- **`functions/src/`** - Firebase Cloud Functions (Node.js 20), compiled to `functions/lib/`
- **`functions/shared/`** - TypeScript types shared between client and server

### Key REST Endpoints (Cloud Functions)

All Firestore access goes through Cloud Functions, not the client SDK:

- **`/doc`** - CRUD for single documents (GET, POST, PUT, PATCH, DELETE)
- **`/docs`** - Collection queries with filtering
- **`/esm`** - Dynamic ES module serving from Firestore
- **`/prefetch`** - Server-side rendering for SEO
- **`/gen`** - LLM text generation (Gemini)
- **`/stored`** - Storage proxy endpoint

### Access Control System

Defined in `functions/src/collections/access.ts`. Each collection has a `CollectionConfig`:

```typescript
COLLECTIONS.post = {
  schema: PostSchema,           // tosijs-schema for validation
  unique: ['path'],             // unique constraints
  cacheLatencySeconds: 60,      // optional read caching
  validate: async (data, userRoles, existing) => { ... },
  access: {
    [ROLES.public]: { read: ALL, list: ALL },
    [ROLES.author]: { write: ['title', 'body'] },
    [ROLES.admin]: { write: ALL, delete: true },
  }
}
```

Roles hierarchy: `public` → `author` → `editor` → `admin` → `developer` → `owner`

### Collection Configs

Located in `functions/src/collections/` and imported in `functions/src/index.ts`. To add a new content type:
1. Create config file in `functions/src/collections/`
2. Import it in `functions/src/index.ts`

### tosijs Framework Patterns

See `.claude/tosijs-notes.md` for detailed framework notes. Key points:

- **Properties**: Initialize to non-undefined (including `null`) for elementCreator to pass them through
- **`content()` vs `render()`**: `content()` runs once on hydration; `render()` runs when properties change
- **Parts**: Use `part="name"` attribute, access via `this.parts.name`
- **Observer pattern**: Build both states in DOM, show/hide based on state (not conditional rendering)
- **`xinValue`**: Use `proxy.xinValue = newValue` for TypeScript-friendly deep assignment with change detection

### tosijs-schema

Validation library used server-side. Key API:
- `s.string`, `s.number`, `s.boolean`, `s.email`, `s.url`
- Modifiers: `.min()`, `.max()`, `.pattern()`, `.optional`
- `s.object({...})`, `s.array(schema)`, `s.enum([...])`
- `validate(value, schema, { onError, fullScan })`

## Project Structure

```
src/                    # Client code (tosijs components)
  index.ts             # App entry, main UI shell
  firebase.ts          # Firebase client wrapper with REST calls
  blog.ts              # Blog component
  style.ts             # Theme configuration
functions/
  src/                 # Cloud Functions
    collections/       # Access control configs per collection
      access.ts        # Core access control system
    doc.ts            # Single document CRUD
    docs.ts           # Collection queries
    utilities.ts      # Shared helpers (getUserRoles, optionsResponse)
  shared/             # Shared TypeScript types
initial_state/        # Seed data for Firestore emulators
public/               # Static assets copied to dist/
dev.ts                # HTTPS dev server with hot reload
```

## Firebase Configuration

- **`.firebaserc`** - Project ID binding
- **`firebase.json`** - Hosting, functions, emulator config
- **`firestore.rules`** - Deny-all (all access through functions)
- **`storage.rules`** - Storage security rules
- **`src/firebase-config.ts`** - Client-side Firebase config (API keys)
