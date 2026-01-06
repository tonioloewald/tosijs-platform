# ES Modules Endpoint

tosijs-platform provides a `/esm` endpoint for serving JavaScript ES modules stored in Firestore. This enables dynamic code loading without deploying new builds.

## Overview

Store JavaScript code in the `module` collection and serve it as ES modules via the `/esm` endpoint. Modules are served with the correct `text/javascript` MIME type and can be dynamically imported by client code.

## The `/esm` Endpoint

### Usage

```
GET /esm/{module-name}
GET /esm/{module-name}.js
GET /esm/{module-name}.jsx
GET /esm/{module-name}.mjs
```

All variations return the same module. Extensions are stripped automatically.

### Example

```javascript
// Dynamic import
const mod = await import('/esm/my-module')
mod.doSomething()
```

## The `module` Collection

Modules are stored in Firestore with the following structure:

```typescript
interface Module {
  name: string        // Unique module name (used in URL)
  source: string      // JavaScript source code
  version: string     // Semantic version (e.g., "1.0.0")
  revisions: number   // Auto-incremented on source changes
  tags: string[]      // Access control and visibility tags
}
```

### Access Control

Defined in `functions/src/module.ts`:

- **Public users**: Can only read modules tagged with `'public'`
- **Public list**: Can only list modules tagged with both `'public'` and `'visible'`
- **Developers**: Full read/write/list access

### Creating a Module

```typescript
// Via REST API (requires developer role)
await fb.service.module.post({
  name: 'my-utils',
  source: `
    export const greet = (name) => \`Hello, \${name}!\`
    export const add = (a, b) => a + b
  `,
  version: '1.0.0',
  tags: ['public', 'visible']
})
```

### Validation Rules

- `source` is required
- `version` must be semantic (e.g., `1.0.0`)
- `tags` must be an array
- `revisions` is auto-incremented when source changes

## The `<tosi-esm>` Component

A web component for declaratively loading ES modules.

### Basic Usage

```html
<tosi-esm module="my-module"></tosi-esm>
```

### Attributes

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `module` | string | `''` | Module name to load |
| `version` | string | `''` | Optional version (for future versioned modules) |
| `method` | string | `''` | Method name to call from the imported module |
| `pass-reference` | boolean | `false` | Pass the element reference to the method |
| `status` | string | `'idle'` | Current status: `'idle'`, `'loading'`, `'ready'`, `'error'` |

### Calling Module Methods

Load a module and call one of its exported functions:

```html
<tosi-esm module="my-renderer" method="render" pass-reference></tosi-esm>
```

This will:
1. Import `/esm/my-renderer`
2. Call `render(element)` where `element` is the `<tosi-esm>` element

### Example Module with Render Method

```javascript
// Stored in module collection as "my-renderer"
export const render = (element) => {
  const div = document.createElement('div')
  div.textContent = 'Dynamically inserted content'
  element.after(div)
}
```

### Status Tracking

The `status` attribute reflects the loading state and can be used for CSS styling:

```css
tosi-esm[status="loading"] {
  opacity: 0.5;
}

tosi-esm[status="error"] {
  display: none;
}
```

## Use Cases

### Dynamic Widgets

Add interactive widgets to pages without rebuilding the app:

```html
<tosi-esm module="weather-widget" method="init" pass-reference></tosi-esm>
```

### A/B Testing

Load different module versions for testing:

```html
<tosi-esm module="checkout-flow-v2" method="render" pass-reference></tosi-esm>
```

### Plugin System

Allow users to extend functionality:

```javascript
// Admin creates a custom module
await fb.service.module.post({
  name: 'custom-analytics',
  source: `
    export const track = (event) => {
      // Custom tracking logic
      console.log('Tracked:', event)
    }
  `,
  version: '1.0.0',
  tags: ['public']
})
```

## Future: Versioned Modules

> **Note**: Versioned module support is planned but not yet implemented.

The endpoint will support semantic versioning:

```
GET /esm/my-module@1.0.0     # Exact version
GET /esm/my-module@^1.0.0    # Compatible version
GET /esm/my-module@latest    # Latest version
```

Versions will be stored as a subcollection of the module document.

## Security Considerations

1. **Code Review**: Modules contain executable code. Only allow trusted users (developers) to create/edit modules.

2. **CSP Headers**: The default Content-Security-Policy allows `'self'` for scripts. Modules served from `/esm` are same-origin and work within this policy.

3. **Access Control**: Use tags to control which modules are publicly accessible. Sensitive utilities should not have the `'public'` tag.

4. **Input Validation**: Modules should validate any data they receive, especially when using `pass-reference`.

## Shared Types

The `Module` interface is available in `functions/shared/module.ts`:

```typescript
import type { Module } from '../functions/shared/module'
```

## See Also

- [functions/src/module.ts](../functions/src/module.ts) - Module collection configuration
- [functions/src/esm.ts](../functions/src/esm.ts) - ESM endpoint implementation
- [src/tosi-esm.ts](../src/tosi-esm.ts) - Client component
