# tosijs-platform TODO

## Outstanding Work

### Testing & Quality

- [ ] **Automated tests for /doc endpoint** - See [functions/src/TODO.md](functions/src/TODO.md)
  - CRUD operations
  - Validation rejection
  - Unique constraint enforcement
  - Role-based access control
  - Nested collection permissions

- [ ] **End-to-end tests**
  - Auth flow (sign in, sign out, role assignment)
  - Blog CRUD operations
  - Media upload/management

### Multi-Environment Support

- [ ] **Staging/testing backend configuration**
  - Easy switching between production, staging, and test Firebase projects
  - Environment-specific config files (e.g., `firebase-config.staging.ts`)
  - CLI flag or env var to select environment at build/dev time
  - Document recommended setup for test/staging projects

- [ ] **Seed data scripts**
  - Script to populate test/staging with sample content
  - Reset script to clear test data

### Developer Experience

- [ ] **Improve create-tosijs-platform-app**
  - Option to skip TLS cert generation (for CI/CD)
  - Validate Firebase project exists before cloning
  - Better error messages for common setup issues

- [ ] **Local development improvements**
  - Optional Firebase emulator support for offline development
  - Mock auth for testing without Google sign-in

### Documentation

- [ ] **API documentation**
  - OpenAPI/Swagger spec for /doc and /docs endpoints
  - Example curl commands for all operations

- [ ] **Deployment guides**
  - Custom domain setup walkthrough
  - CI/CD pipeline examples (GitHub Actions, etc.)
  - Cost optimization tips

### Features

- [ ] **Media management**
  - Image optimization/resizing on upload
  - Bulk upload support
  - Media library UI improvements

- [x] **Content features**
  - [x] Scheduled publishing (publish date in future)
  - [ ] Draft previews with shareable links
  - [ ] Content versioning/history

- [ ] **Search**
  - Full-text search integration (Algolia, Typesense, or built-in)
  - Search UI component

### Extensibility

- [ ] **Component editor**
  - Visual editor for adding components/libraries to pages
  - Direct component upload or CDN link ingestion
  - Components become available site-wide after ingestion
  - Versioned, cache-friendly endpoint for component delivery
  - Parallel self-assembly of page components
  - Learned dependency graph: system observes import() chains and caches transitive dependencies
  - Subsequent loads parallelize all dependencies (bundling benefits without bundling)
  - Each component independently cacheable and updatable

### Performance

- [ ] **Caching improvements**
  - CDN cache headers configuration
  - Stale-while-revalidate patterns
