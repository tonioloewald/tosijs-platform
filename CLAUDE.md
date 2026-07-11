# CLAUDE.md

> **Shared engineering practices** live at
> **https://github.com/tonioloewald/tosijs-coding-practices** — and, when checked out beside
> this repo, at [`../tosijs-coding-practices`](../tosijs-coding-practices/README.md). Read that
> index first for the cross-project defaults (development, testing, code quality, performance,
> review, releasing, deployment, and the **observant** tosijs/tjs stack). This file records only
> what is **specific to or divergent from** those defaults — when they conflict, this file wins.
>
> Those docs are **living, not graven in stone.** Don't rewrite them unprompted, but do speak up:
> voice concerns, flag inconsistencies, and suggest improvements as you work. Continuous
> improvement is the goal — see the repo's `CONTRIBUTING.md`.


This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is **tosijs-platform**, a full-stack web application platform built on Firebase and tosijs. It provides a CMS-like system with blog, pages, and custom content types, using Cloud Functions for secure REST API access with role-based access control.

## Direction (read before large changes)

The platform is pivoting — see **[ROADMAP.md](ROADMAP.md)**. Target: a **universal endpoint +
ajs (tjs-lang) stored procedures** model, where collections, access rules, and validators live in
Firestore as *data* and the Cloud Functions layer is a generic interpreter. Consequences for any
work here:

- **`blog.ts`, `page.ts`, `sitemap.ts`, `prefetch.ts`, and the bespoke blog/page/schema editors
  are slated for removal (Phase 2).** Don't extend or refactor them for their own sake — they
  become records + schemas + ajs procs.
- **The security model survives and generalizes.** `doc.ts`/`docs.ts` (the universal document
  atom), the auth atom (`user.ts`), and hardened `gen`/`stored` are the trusted core (TCB).
- **Before touching `access.ts` or the write/validate path**, read the *Design invariants* in
  ROADMAP.md — decisions about buffered/transactional capabilities, system-owned provenance
  stamps, authority-in-the-cache-key, typed-union write outcomes, and schema-vs-ajs boundaries
  were reasoned through and shouldn't be relitigated.
- **First concrete task is test backfill:** the `validate`/write/`unique`/provenance path is
  essentially untested (dispatch logic is covered). See TODO.md.

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
bun latest             # Upgrade Bun + reinstall root and functions deps
bun seed-production    # Seed production Firestore (scripts/seed-production.js)
bun initial-deploy     # First-time deploy bootstrap (scripts/initial-deploy.js)
```

### Functions development

```bash
cd functions
bun test                                    # Run all tests (*.test.ts)
bun test src/collections/access.test.ts     # Run a single test file
bun test -t "pattern"                       # Run tests matching a name pattern
bun run build                               # Compile TypeScript to lib/
npm run lint                                # Lint (eslint, google config)
```

Tests come in two flavors. Unit tests (`*.test.ts`, e.g. `access.test.ts`) run standalone. Integration tests (`*.integration.test.ts`, e.g. `access.integration.test.ts`) hit live endpoints and are **skip-guarded** — they pass vacuously (`expect(true).toBe(true)`) unless emulators are up, so a green CI run does not mean they exercised anything. To actually run them: `cd functions && bun run build`, then from the root `bun start-emulated` + `bun seed`, then `bun test src/collections/access.integration.test.ts`. The emulators run compiled code from `lib/`, so **rebuild and restart emulators** after changing functions.

Note: `functions/` installs with npm (`package-lock.json`), even though the root project uses Bun. The root `bun start` connects directly to **production** Firebase over HTTPS — use `bun start-emulated` + `bun seed` for isolated local work.

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
- **`/prefetch`** (+ `/prefetchData`) - Server-side rendering for SEO
- **`/gen`** - LLM text generation (Gemini); uses `defineSecret` for API keys
- **`/stored`** - Storage proxy endpoint
- **`/cachedQuery`** - Cached collection queries
- **`/sitemap`** - Sitemap generation
- **`/state`**, **`/user`** - App state and user/role management

Endpoints are individual Firebase v2 `onRequest` functions, each exported from `functions/src/index.ts`. New endpoints follow the pattern in `functions/src/hello.ts`: handle CORS via `optionsResponse`, get roles via `getUserRoles` (both from `utilities.ts`), then export from `index.ts`.

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

The `COLLECTIONS` map is defined in `functions/src/collections/index.ts`; the access-control engine and role definitions live in `functions/src/collections/access.ts` and `roles.ts`. Individual collection configs register themselves by mutating `COLLECTIONS` (e.g. `COLLECTIONS.post = {...}`) when their module is imported.

Config files are split across two locations and are activated only by being imported in `functions/src/index.ts`:
- `functions/src/collections/` - core/internal collections (`module`, `config`, `role`)
- `functions/src/` - content collections that also export endpoints (`blog.ts`, `page.ts`)

To add a content type: create the config module, assign to `COLLECTIONS.<name>`, and add a side-effect `import './<name>'` in `functions/src/index.ts`. A collection with no config is fully inaccessible (deny-by-default).

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
