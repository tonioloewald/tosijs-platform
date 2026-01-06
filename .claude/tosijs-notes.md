# tosijs Framework Notes

## tosijs Component Base Class

### Properties and Initialization

- Properties initialized to a non-undefined value (including `null`) are recognized by `elementCreator` as settable properties
- Properties left `undefined` are not passed through by `elementCreator`
- The `on` prefix (e.g., `onChange`, `onValueChange`) is treated as syntax sugar for event handlers, not property assignment

### Value Property Pattern

- Component base class has built-in support for a `value` property
- Setting `value` from outside triggers `render()`
- Use `render()` method for updating UI when properties change
- `content()` is called once on hydration; `render()` is called when properties change

### Parts System

- Define parts interface extending `PartsMap`
- Access parts via `this.parts` after component is connected
- Parts are elements with `part="name"` attribute
- Example: `div({ part: 'container' })` creates `this.parts.container`

### Observer Pattern (not Reactive)

- tosijs uses an observer pattern, not a reactive framework
- UI is stable by default, not an ephemeral consequence of state
- Build both views in DOM and show/hide based on state (rather than conditional rendering)
- Custom bindings for show/hide:
  ```typescript
  const showBinding = {
    toDOM(element: HTMLElement, value: boolean) {
      element.style.display = value ? '' : 'none'
    }
  }
  div({ bind: { value: someState, binding: showBinding } })
  ```

### xinValue and Proxy Assignment

- Use `someProxy.xinValue = newValue` for TypeScript-friendly deep assignment
- This triggers proper change detection with deep comparison
- `touch()` is only needed when directly mutating properties, not when using proxy assignment

### bindList with Filtering

- `bindList` has built-in `filter` and `needle` options:
  ```typescript
  bindList: {
    value: items,
    filter: (items, needle) => items.filter(...),
    needle: filterState
  }
  ```
- Don't use computed getters for filtered lists - they don't trigger updates

## tosijs-ui Components

### xinSelect

- Use arrays for options (more robust than comma-delimited strings):
  ```typescript
  xinSelect({
    options: ['email', 'phone', 'address'],  // array, not string
    value: currentValue,
    placeholder: 'Select...',
    onChange: handler
  })
  ```
- Has a `value` property for getting/setting selected value
- No race condition with assigning values not in the list

### postNotification

- `duration` is in seconds, not milliseconds
- Types: 'info', 'error', 'progress'
- Progress notifications return a close function

## tosijs-schema

### API Overview

- Lean API designed to be simpler than zod
- Access via `import { s, validate, type Infer } from 'tosijs-schema'`

### Types

```typescript
s.string          // string
s.number          // number
s.integer         // integer (number with int constraint)
s.boolean         // boolean
s.any             // any
s.email           // email string (direct, not s.string.email)
s.uuid            // UUID string
s.url             // URL string
s.datetime        // datetime string
```

### Modifiers

```typescript
s.string.min(1)           // minLength (not minLength!)
s.string.max(100)         // maxLength
s.string.pattern(/regex/) // regex pattern
s.number.min(0)           // minimum value
s.number.max(100)         // maximum value
s.number.int              // integer constraint
s.array(itemSchema).min(1) // min items
s.array(itemSchema).max(10) // max items
```

### Metadata

```typescript
schema.title('Title')           // display title
schema.describe('Description')  // description (used for placeholders)
schema.default(value)           // default value
schema.meta({ key: value })     // custom metadata
schema.optional                 // make optional
```

### Composite Types

```typescript
s.enum(['a', 'b', 'c'])                    // enum
s.enum(['single'])                          // literal (single-value enum)
s.array(itemSchema)                         // array
s.object({ prop: schema })                  // object
s.union([schemaA, schemaB])                 // union (discriminated)
s.tuple([s.string, s.number] as const)      // tuple
s.record(valueSchema)                       // Record<string, T>
```

### Validation

```typescript
import { validate } from 'tosijs-schema'

const isValid = validate(value, schema, {
  onError: (path, message) => {
    console.log(`Error at ${path}: ${message}`)
  },
  fullScan: true  // continue after first error
})
```

### Getting JSON Schema

- Schema builders have a `.schema` property for raw JSON Schema:
  ```typescript
  const jsonSchema = MySchema.schema
  ```

### Type Inference

```typescript
import { type Infer } from 'tosijs-schema'

const UserSchema = s.object({
  name: s.string,
  age: s.number.optional
})

type User = Infer<typeof UserSchema>
// { name: string; age?: number }
```

## Document System Notes

### _path vs _id

- `_id` is stripped from records when returned from the API
- `_path` is available and more useful for identifying documents
- Use `_path` for update/delete operations
