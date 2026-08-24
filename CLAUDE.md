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

The platform is pivoting — see **[ROADMAP.md](ROADMAP.md)** (direction settled 2026-08-24).
**This repo consolidates into the pure backend** — `/doc` + `/docs` + one universal stored-ajs
endpoint, with everything else expressed as collection config or stored ajs — while all client code
moves *out* (upstream to tosijs-ui, or into small projects **`tosijs-blog`** and **`tosijs-assets`**).
Its own hosting becomes a standard **tosijs-ui build deployed to Firestore**, served via `/prefetch`
as cached SSR HTML. Consequences for any work here:

- **Client code is leaving — don't invest in it.** `blog.ts` (+ the blog/page/schema editors) →
  `tosijs-blog`; `asset-manager.ts` → `tosijs-assets`; generic bits → upstream to tosijs-ui.
  `page.ts` and `sitemap.ts` are removed; `prefetch.ts`'s SSR-*data-injection* role is removed and
  re-cast as a cached-HTML page server.
- **The backend is where value concentrates.** `doc.ts`/`docs.ts` (the universal document atom),
  the auth atom (`user.ts`), and hardened `gen`/`stored` are the trusted core (TCB); the backend
  half of tjs-lang's reference universal endpoint consolidates *here*.
- **The ajs/security design is NOT frozen.** It is grounded on **tjs-lang 0.13.1** (released; shape
  settled, patches possible) and is *provisional* — re-validate against 0.13.1's primitives (re-run
  the VM spike) before building backend internals. The old "design invariants — don't relitigate"
  framing is **retired**; see ROADMAP.md.
- **Testability falls out of the split:** once unique code is all backend and ajs is deterministic
  (mock the capabilities), the write-path oracle (`validate.test.ts`, `access.test.ts`,
  `write-path.integration.test.ts`) runs without emulators.

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

**Emulator gotcha:** the globally installed `firebase-tools` is **10.1.0**, which is incompatible with firebase-functions v7 — the functions emulator runtime calls the removed `functions.config()` and crashes on startup, so **`bun start-emulated` fails as written**. Until the global CLI is upgraded, start emulators with:

```bash
npx -y firebase-tools@latest emulators:start --only auth,functions,firestore
```

Emulator ports (see `firebase.json`): UI 4000, functions 5001, hosting 5002, firestore 8080, auth 9099, storage 9199. `bun run kill-ports` frees all six; `start-emulated` runs it first.

Note: `functions/` is npm-managed — `package-lock.json` is authoritative and `firebase.json`'s `predeploy` runs `npm run lint` + `npm run build` — even though the root project uses Bun and a stray `functions/bun.lock` exists. `bun test` still works there for running tests. The root `bun start` connects directly to **production** Firebase over HTTPS — use emulators + `bun seed` for isolated local work.

## Architecture

### Client-Server Split

- **`src/`** - Client-side TypeScript, built with Bun to `dist/`
- **`functions/src/`** - Firebase Cloud Functions (Node.js 20), compiled to `functions/lib/`
- **`functions/shared/`** - TypeScript types shared between client and server

`functions/shared/` is imported by *both* tiers by relative path — client files do
`import { Page } from '../functions/shared/page'`, reaching outside `src/`. It is not listed in
`functions/tsconfig.json`'s `include`, but gets pulled into the build via those imports, which is
why output lands in `lib/shared/` + `lib/src/` and `functions/package.json` declares
`main: "lib/src/index.js"`. **Editing a file in `shared/` changes both the client bundle and the
deployed functions** — check both sides.

Two build quirks worth knowing before touching them: `functions/tsconfig.json` excludes
`src/gen.ts` (and all `*.test.ts`), and `firebase.json`'s functions `ignore` list excludes
`**/gen.ts` and `**/gen.js` from upload — while `src/index.ts` still exports `gen`. Verify what
actually ships before assuming a `gen.ts` change deploys.

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

### Client Data Access

`src/firebase.ts` exports `service`, a **nested Proxy** — `service.<endpoint>.<method>(data)`
(e.g. `fb.service.module.post({...})`, `service.record.put({...})`). There are no declared
per-endpoint members, so grep and autocomplete won't reveal the surface: any property name
resolves to an endpoint URL, and any HTTP verb resolves to a request function. It attaches the
Firebase ID token as a `Bearer` header automatically, and routes `GET`/`DELETE` payloads to the
query string vs. `POST`/`PUT`/`PATCH` to the body. `TEST_MODE` switches `baseServiceUrl` between
emulators and production.

Global client state lives in `src/app.ts` as a `tosi({ app: {...} })` proxy, imported directly by
components rather than passed down. It is exposed on `window` (alongside `blog`, `fb`, `tosi`)
by `src/index.ts`, which is useful for poking at state in the browser console.

### tosijs Framework Patterns

See `.claude/tosijs-notes.md` for detailed framework notes. Key points:

- **Properties**: Initialize to non-undefined (including `null`) for elementCreator to pass them through
- **`content()` vs `render()`**: `content()` runs once on hydration; `render()` runs when properties change
- **Parts**: Use `part="name"` attribute, access via `this.parts.name`
- **Observer pattern**: Build both states in DOM, show/hide based on state (not conditional rendering)
- **`.value`**: Use `proxy.value = newValue` for TypeScript-friendly deep assignment with change
  detection; `tosiValue(proxy)` unwraps a proxy to a plain object. The `xin*` spellings
  (`.xinValue`, `xinValue()`) are deprecated — as of tosijs 1.7 `xinValue` is no longer declared
  on `XinProps`, so `.xinValue` still works at runtime but no longer typechecks.

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
  app.ts               # The `app` tosi state proxy (global singleton)
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
docs/                 # Endpoint/component reference (see caveat below)
dev.ts                # HTTPS dev server with hot reload
```

`docs/` holds the long-form reference for each subsystem — `FIRESTORE_API.md` (`/doc`, `/docs`,
roles), `CLOUD_FUNCTIONS.md`, `ESM_MODULES.md`, `PREFETCH.md`, `GEN_ENDPOINT.md`,
`STORED_ENDPOINT.md`, `SCHEMA_VALIDATION.md`, `BLOG_COMPONENT.md`, `PAGE_COMPONENT.md`. Useful for
intent, but **the file paths in them predate the `collections/` reorg** — `access.ts`, `roles.ts`,
`module.ts`, and the `COLLECTIONS` map are cited as `functions/src/*.ts` when they now live in
`functions/src/collections/`. Trust the code over these paths.

## Firebase Configuration

- **`.firebaserc`** - Project ID binding
- **`firebase.json`** - Hosting, functions, emulator config
- **`firestore.rules`** - Deny-all (all access through functions)
- **`storage.rules`** - Storage security rules
- **`src/firebase-config.ts`** - Client-side Firebase config (API keys)

**Hosting rewrites matter more than they look.** `firebase.json` routes `/sitemap.xml` → `sitemap`,
`/esm/*` → `esm`, `/stored/**` → `stored`, and then **`**` → `prefetch`** — so every request not
matching a static file in `dist/` is served by the `prefetch` function, not by static hosting. That
catch-all is what makes SSR/SEO work, and it means a routing or 404 bug in production is usually a
`prefetch.ts` bug. (Per ROADMAP Phase 2, `prefetch.ts` and `sitemap.ts` are slated for removal —
so change these rewrites deliberately, not incidentally.) `hosting.headers` also sets a CSP that
allows `unsafe-eval` and a specific CDN allowlist; dynamically loaded `/esm` modules depend on it.
