# /doc endpoint

## Implemented Features

- [x] Filtered property lists (FieldAccessMap)
- [x] GET / POST / PUT / PATCH / DELETE operations
- [x] Validation enforcement (returns 400 on Error)
- [x] Unique field enforcement
- [x] Public access for unauthenticated users
- [x] Tiered role-based access (roles override in order)
- [x] Filter functions (AccessFilterFunc)
- [x] Subrecords / nested collection permissions (e.g., `post/comment`)

## Outstanding

- [ ] Automated tests for /doc endpoint
  - CRUD operations
  - Validation rejection
  - Unique constraint enforcement
  - Role-based access control
  - Nested collection permissions
