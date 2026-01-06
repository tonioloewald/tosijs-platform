# Schema Validation

tosijs-platform uses [tosijs-schema](https://www.npmjs.com/package/tosijs-schema) for schema-first type definitions and validation throughout the stack.

## Overview

Schema validation provides:
- **Type safety** - Define schemas once, infer TypeScript types automatically
- **Server-side validation** - Automatic validation in doc endpoints before data is stored
- **Client-side validation** - Schema-driven form editors with built-in validation
- **Structured LLM responses** - Use schemas with the `/gen` endpoint for validated JSON output

## Defining Schemas

Schemas are defined in `functions/shared/` using tosijs-schema's builder syntax:

```typescript
import { s, type Infer } from 'tosijs-schema'

export const PageSchema = s.object({
  title: s.string,
  description: s.string,
  path: s.string,
  imageUrl: s.string,
  source: s.string,
  tags: s.array(s.string).optional,
  type: s.string.optional,
})

export type Page = Infer<typeof PageSchema>
```

### Available Types

| Type | Example |
|------|---------|
| String | `s.string` |
| Number | `s.number` |
| Integer | `s.integer` |
| Boolean | `s.boolean` |
| Array | `s.array(s.string)` |
| Object | `s.object({ key: s.string })` |
| Enum | `s.enum(['a', 'b', 'c'])` |
| Optional | `s.string.optional` |

### Constraints

```typescript
// String constraints
s.string.min(1).max(100)           // Length limits
s.string.pattern(/^\d+$/)          // Regex pattern
s.string.email                      // Email format
s.string.url                        // URL format

// Number constraints
s.number.min(0).max(100)           // Range
s.integer.min(0)                   // Non-negative integer

// Array constraints
s.array(s.string).min(1).max(10)   // Array length limits
```

### Metadata

Add metadata for documentation and UI hints:

```typescript
export const RoleSchema = s
  .object({
    name: s.string.title('Name').describe('Display name for this role'),
    roles: s.array(s.string).title('Roles'),
  })
  .title('Role')
  .describe('User role assignment configuration')
```

## Collection Schema Validation

Add schemas to collection configurations for automatic server-side validation:

```typescript
// functions/src/page.ts
import { PageSchema } from '../shared/page'

COLLECTIONS.page = {
  schema: PageSchema,  // Automatic validation
  unique: ['path'],
  access: {
    // ... access rules
  },
}
```

### Validation Flow

1. **Schema validation runs first** - Checks types, constraints, and required fields
2. **Custom validate() runs second** - Business logic like auto-generating paths
3. **Unique constraints checked last** - Ensures field uniqueness

### Error Response

When schema validation fails, the endpoint returns a detailed error:

```json
{
  "error": "schema validation failed",
  "details": [
    { "path": "title", "message": "Required field missing" },
    { "path": "version", "message": "Pattern mismatch" }
  ]
}
```

## Structured LLM Responses

The `/gen` endpoint supports schema-validated structured output:

```typescript
// Request with schema
const response = await fetch('/gen', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    prompt: 'Extract the name and email from: John Doe <john@example.com>',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string', format: 'email' }
      },
      required: ['name', 'email']
    }
  })
})

const result = await response.json()
// {
//   modelId: 'gemini-2.5-flash-lite',
//   prompt: '...',
//   data: { name: 'John Doe', email: 'john@example.com' },
//   valid: true
// }
```

### Using Schema Builders

You can pass the `.schema` property from tosijs-schema builders:

```typescript
import { ContactSchema } from './shared/role'

const response = await fetch('/gen', {
  method: 'POST',
  body: JSON.stringify({
    prompt: 'Parse this contact info...',
    schema: ContactSchema.schema  // Raw JSON Schema
  })
})
```

## Schema-Driven Editor Component

The `<schema-editor>` component generates forms from JSON schemas:

```typescript
import { schemaEditor } from './schema-editor'
import { RoleSchema } from '../functions/shared/role'

// Render a form for editing roles
schemaEditor({
  schema: RoleSchema.schema,
  value: existingRole,
  onChange: (value, isValid) => {
    console.log('Form data:', value)
    console.log('Is valid:', isValid)
  }
})
```

### Schema-to-Field Mapping

| Schema Property | Form Field |
|-----------------|------------|
| `type: 'string'` | Text input |
| `type: 'string'` + `multiline: true` | Textarea |
| `type: 'number'` / `type: 'integer'` | Number input |
| `type: 'boolean'` | Checkbox |
| `enum: [...]` | Select dropdown |
| `type: 'array'` | Repeatable field group |
| `type: 'object'` | Nested fieldset |

### Metadata in UI

- `title` → Field label
- `description` → Tooltip/help text
- `default` → Initial value
- `minimum`/`maximum` → Input min/max attributes
- `pattern` → Input pattern attribute

## Role Manager

The Role Manager (`<role-manager>`) is a built-in admin tool for managing user roles:

- Available from the menu for admin, developer, and owner roles
- Uses the schema-driven editor for role editing
- Full CRUD operations for role records

## Shared Schema Files

| File | Schemas |
|------|---------|
| `functions/shared/page.ts` | `PageSchema`, `PrefetchSchema` |
| `functions/shared/module.ts` | `ModuleSchema` |
| `functions/shared/book.ts` | `BookSchema`, `LinkSchema`, `BlockSchema`, `SectionSchema` |
| `functions/shared/role.ts` | `RoleSchema`, `ContactSchema` |
| `functions/shared/post.ts` | `PostSchema` |

## Best Practices

1. **Define schemas in `functions/shared/`** - Keeps them accessible to both server and client
2. **Export both schema and type** - `export const MySchema = ...` and `export type My = Infer<typeof MySchema>`
3. **Use metadata for UX** - Add `title()` and `describe()` for better form labels
4. **Keep validate() for business logic** - Use schemas for structure, custom validate for computed fields
5. **Test with emulators** - Run `bun start-emulated` to test validation locally

## See Also

- [tosijs-schema documentation](https://www.npmjs.com/package/tosijs-schema)
- [Firestore REST API & Security](./FIRESTORE_API.md)
- [LLM Generation Endpoint](./GEN_ENDPOINT.md)
