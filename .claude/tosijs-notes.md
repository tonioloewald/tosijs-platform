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

### .value and Proxy Assignment

- Use `someProxy.value = newValue` for TypeScript-friendly deep assignment
- This triggers proper change detection with deep comparison
- `touch()` is only needed when directly mutating properties, not when using proxy assignment
- Use `tosiValue(proxy)` to unwrap a proxy to a plain object
- **Deprecated `xin*` spellings:** `.xinValue` / `xinValue()` still work at runtime, but as of
  tosijs 1.7 `xinValue` is not declared on `XinProps`, so `.xinValue` fails to typecheck. The
  whole `xin*` surface is deprecated in favor of `tosi*` — see [Migrating off `xin*`](#migrating-off-xin-tosijs-17) below.

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
- **Schema-first, not types-first.** Unlike zod (where the schema is a runtime byproduct of TS),
  the tosijs-schema definition is a serializable *source* artifact. This is load-bearing for the
  platform direction: schemas can be **stored as data** (change shape without redeploy) and can
  drive server validation, client types, the ajs strainer, and the atom ABI from one source.
  It's also the foundation `tjs-lang`/`ajs` is built on.
- **Schema is both guard and strainer** (same engine): validating rejects bad data; "straining"
  passes data *through* a schema, dropping fields not in the shape. This means access-level field
  filtering can be expressed as a sub-schema, and the strained output is type-sound (its type =
  the projection schema). See ROADMAP.md invariants 11–13 for the schema-vs-ajs boundary
  (schema = intra-document shape/whitelist; ajs = inter-value/relational conditions).

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

## tjs-lang / ajs (planned)

The direction for the server tier — a sandboxed, gas-limited, capability-based, type-safe
language that turns validation and access rules into **safe stored procedures** (data, not
deployed code). The security details, guarantees, and design invariants live in
**[ROADMAP.md](../ROADMAP.md)**. Key one-liners to keep in mind if it comes up:

- The VM is *amoral* — security is at the capability (atom) boundary, not in the language.
- Guarantees are confinement + termination + type-soundness, **not** correctness.
- Procs are pure functions of `(inputs, capability-responses)` → deterministic, replayable, and
  unit-testable without emulators.

## Migrating off `xin*` (tosijs 1.7)

The `xinjs` → `tosijs` rename deprecated the whole `xin*` surface. Most aliases still exist and
still work, so **nothing fails loudly** — but the CSS/DOM half fails *silently*, and that is the
dangerous part. Renames applied in this repo (2026-07):

| old | new | how it failed |
| --- | --- | --- |
| `proxy.xinValue` | `proxy.value` | typecheck error only; runtime fine |
| `xinValue(obj)` | `tosiValue(obj)` | still exported; deprecated |
| `xinSelect` / `XinSelect` | `tosiSelect` / `TosiSelect` | deprecated alias, still works |
| `xinFloat`, `xinSizer`, `xinSegmented` | `tosiFloat`, `tosiSizer`, `tosiSegmented` | deprecated alias, still works |
| `<xin-select>`, `<xin-code>`, `<xin-tabs>`, `<xin-float>`, `<xin-sizer>`, `<xin-sidenav>`, `<xin-example>`, `<xin-carousel>`, `.xin-menu*` | `tosi-*` equivalents | **silent** — selectors and `querySelector` stop matching |
| `<xin-word>` | `<tosi-rich-text>` | **silent** |
| `_xinTabsSelectedColor`, `_xinTabsBarColor` | `_tosiTabs*` | **silent** — style just stops applying |

Two traps worth remembering:

- **`document.querySelector('xin-…')` degrades instead of throwing.** In `asset-manager.ts` the
  stale `xin-code` selector made `codeEditor` always `null`, so "insert asset into editor"
  quietly became "copy to clipboard" with no error anywhere.
- **Locally-defined tags keep their `xin-` names and must NOT be renamed.** `xin-blog`,
  `xin-blog-post`, `xin-blog-post-list`, `xin-blog-search`, `xin-post-editor`, and `xin-page` are
  ours (declared in `src/`). So are the `_xinBlogPad` / `_xinBlogBodyBg` CSS vars — self-consistent,
  and renaming them buys nothing. `'xin-blog-editor-post'` is a **localStorage key**: renaming it
  would orphan users' saved drafts.

To find real breakage, diff `grep -o "xin-[a-z-]*" src/*.ts` against the tags tosijs-ui actually
registers (`grep -rho "'tosi-[a-z-]*'" node_modules/tosijs-ui/dist/*.js | sort -u`).

## The code editor is CodeMirror 6, not ACE (tosijs-ui 1.7)

`codeEditor`'s `editor` property **changed type in place** — ACE `Editor` → CodeMirror `EditorView`
— so a grep for removed names won't catch call sites. It is also `undefined` until the editor
mounts, so guard it. Equivalents used here:

- insert at cursor: `editor.dispatch(editor.state.replaceSelection(text))`
- lint annotations: `editor.dispatch(setDiagnostics(editor.state, diagnostics))` from
  `@codemirror/lint`. Diagnostics are character offsets (`{from, to, severity, message}`), not
  ACE's `{row, text, type}`; convert with `doc.line(row + 1)` (CodeMirror lines are 1-based).
  `setDiagnostics` self-enables the lint extension, so the editor needn't opt in.
- undo/redo: `undo()` / `redo()` / `canUndo()` / `canRedo()` on the component.
- tooltip styling: `.cm-tooltip` (was `.ace-tooltip`).

## Getters inside `tosi({...})` registrations (tosijs 1.7)

`tosi()` `Object.assign`s over the object literal you pass it. That does two things a getter-only,
self-referencing computed property cannot survive — and it fails at **module load**, so the whole
app dies on launch:

1. it **invokes the getter** during registration, before `const { data } = tosi({...})` has been
   assigned — so a getter body referencing the outer `data` binding throws
   (`Cannot access 'data' before initialization`, or `Cannot read properties of undefined` once
   bundled, since the bundler drops the TDZ);
2. it then **writes the value back**, which throws `Attempted to assign to readonly property` if
   the property has no setter.

So a computed property in a `tosi()` registration needs **both** fixes:

```ts
const { data } = tosi({
  data: {
    files: [] as Asset[],
    filter: '',
    get filtered(): Asset[] {
      const filter = String(this.filter).toLocaleLowerCase()   // `this`, NOT `data`
      const { files } = this as unknown as { files: Asset[] }
      return filter === '' ? files : files.filter(/* … */)
    },
    set filtered(_v: Asset[]) {},                              // no-op setter is required
  },
})
```

`this` is the raw literal during registration and the proxy afterwards, so it resolves in both
phases and stays reactive (`touch()` and list bindings still work).

Guarding with `if (typeof data === 'undefined')` does **not** work — `typeof` on a TDZ `const`
still throws.

Not affected: getters on `Component`/`WebComponent` **classes** (`blog.ts`, `page.ts`) — this is
only about object literals handed to `tosi()`. `theme.mode` in `style.ts` is inside a `tosi()`
block but survives because it already has a setter and reads `localStorage` rather than its own
binding.
