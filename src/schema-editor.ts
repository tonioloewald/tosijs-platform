/**
 * Schema-driven form editor component
 *
 * Dynamically generates form fields from a JSON Schema.
 * Handles nested objects, arrays, and various field types.
 */

import { Component, ElementCreator, PartsMap, elements, vars } from 'tosijs'
import { icons, xinSelect, XinSelect, popMenu } from 'tosijs-ui'
import { isSystemField } from '../functions/shared/system-fields'

const { div, label, input, fieldset, legend, button, span, form } = elements

// JSON Schema types
interface JSONSchema {
  type?: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema
  enum?: string[]
  anyOf?: JSONSchema[] // union types
  const?: any // literal values
  title?: string
  description?: string
  default?: any
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  multiline?: boolean
  readOnly?: boolean
  hidden?: boolean
}

interface SchemaEditorParts extends PartsMap {
  container: HTMLElement
}

// Helper to convert property name to display label
const toLabel = (key: string, schema: JSONSchema): string => {
  if (schema.title) return schema.title
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim()
}

// Helper to determine if field should be shown
const shouldShowField = (key: string, schema: JSONSchema): boolean => {
  if (isSystemField(key)) return false
  if (schema.hidden) return false
  return true
}

export class SchemaEditor extends Component<SchemaEditorParts> {
  schema: JSONSchema = {}
  value: Record<string, any> = {}
  isValid = true

  // Extract current value from the DOM
  extractValue = (): Record<string, any> => {
    const result: Record<string, any> = { ...this.value }
    const { container } = this.parts

    // Get simple field values
    container.querySelectorAll('[data-key]').forEach((el: any) => {
      const key = el.getAttribute('data-key')
      if (!key || key.includes('[')) return // Skip array items

      if (el.classList.contains('array-field')) {
        // Handle array fields
        const items = el.querySelectorAll(':scope > .array-items > .array-item')
        const values: any[] = []
        items.forEach((item: HTMLElement) => {
          const objectField = item.querySelector('.object-field')
          if (objectField) {
            // Nested object in array
            const obj: Record<string, any> = {}
            objectField.querySelectorAll('[data-key]').forEach((field: any) => {
              const fieldKey = field.getAttribute('data-key')
              if (fieldKey && !fieldKey.includes('[')) {
                obj[fieldKey] = this.getFieldValue(field)
              }
            })
            values.push(obj)
          } else {
            // Simple value in array - check for xinSelect first
            const xinSelectEl = item.querySelector(
              'xin-select'
            ) as XinSelect | null
            if (xinSelectEl) {
              values.push(xinSelectEl.value)
            } else {
              const inputEl = item.querySelector(
                'input'
              ) as HTMLInputElement | null
              if (inputEl) {
                values.push(inputEl.value)
              }
            }
          }
        })
        result[key] = values
      } else if (
        !el.closest('.array-field') &&
        !el.closest('.object-field[data-key]')
      ) {
        // Top-level field (not inside array or nested object)
        result[key] = this.getFieldValue(el)
      }
    })

    return result
  }

  getFieldValue = (el: HTMLElement): any => {
    // Check for xinSelect first
    const xinSelectEl = el.querySelector('xin-select') as XinSelect | null
    if (xinSelectEl) {
      return xinSelectEl.value
    }

    const inputEl = el.querySelector('input') as HTMLInputElement | null
    if (!inputEl) return undefined
    if (inputEl.type === 'checkbox') {
      return inputEl.checked
    }
    if (inputEl.type === 'number') {
      return inputEl.value ? Number(inputEl.value) : undefined
    }
    return inputEl.value
  }

  handleChange = () => {
    this.value = this.extractValue()
    this.checkValidity()
  }

  // Check form validity using native browser validation
  checkValidity = (): boolean => {
    const { container } = this.parts
    const formEl = container.querySelector('form') as HTMLFormElement | null
    if (formEl) {
      this.isValid = formEl.checkValidity()
      return this.isValid
    }
    return true
  }

  // Report validity - shows browser's native validation UI
  reportValidity = (): boolean => {
    const { container } = this.parts
    const formEl = container.querySelector('form') as HTMLFormElement | null
    if (formEl) {
      this.isValid = formEl.reportValidity()
      return this.isValid
    }
    return true
  }

  // Build a field element
  buildField = (
    key: string,
    schema: JSONSchema,
    parentSchema: JSONSchema,
    value: any
  ): HTMLElement => {
    const labelText = toLabel(key, schema)
    const isRequired = parentSchema.required?.includes(key)

    // Handle const or single-value enum as read-only
    if (
      schema.const !== undefined ||
      (schema.enum && schema.enum.length === 1)
    ) {
      const constValue = schema.const ?? schema.enum![0]
      return div(
        { class: 'field', 'data-key': key },
        label(
          span(labelText),
          input({
            value: constValue,
            readOnly: true,
            disabled: true,
          })
        )
      )
    }

    // Handle enum as xinSelect
    if (schema.enum) {
      return div(
        { class: 'field', 'data-key': key },
        label(
          span(labelText, isRequired ? span({ class: 'required' }, ' *') : {})
        ),
        xinSelect({
          options: schema.enum,
          value: value ?? schema.default ?? '',
          placeholder: schema.description || '-- Select --',
          onChange: this.handleChange,
        })
      )
    }

    // Handle arrays
    if (schema.type === 'array' && schema.items) {
      return this.buildArrayField(key, schema, value || [])
    }

    // Handle nested objects
    if (schema.type === 'object' && schema.properties) {
      return this.buildObjectField(key, schema, value || {})
    }

    // Build input attributes
    const inputAttrs: Record<string, any> = {
      value: value ?? schema.default ?? '',
      onChange: this.handleChange,
    }

    if (schema.minimum !== undefined) inputAttrs.min = schema.minimum
    if (schema.maximum !== undefined) inputAttrs.max = schema.maximum
    if (schema.minLength !== undefined) inputAttrs.minlength = schema.minLength
    if (schema.maxLength !== undefined) inputAttrs.maxlength = schema.maxLength
    if (schema.pattern) inputAttrs.pattern = schema.pattern
    if (schema.description) {
      inputAttrs.title = schema.description
      inputAttrs.placeholder = schema.description
    }
    if (isRequired) inputAttrs.required = true

    // Determine input type
    switch (schema.type) {
      case 'number':
      case 'integer':
        inputAttrs.type = 'number'
        if (schema.type === 'integer') inputAttrs.step = 1
        break
      case 'boolean':
        inputAttrs.type = 'checkbox'
        inputAttrs.checked = !!value
        delete inputAttrs.value
        break
      default:
        inputAttrs.type = 'text'
        if (schema.format === 'email') {
          inputAttrs.type = 'email'
        } else if (schema.format === 'date') {
          inputAttrs.type = 'date'
        }
    }

    return div(
      { class: 'field', 'data-key': key },
      label(
        span(labelText, isRequired ? span({ class: 'required' }, ' *') : {}),
        input(inputAttrs)
      )
    )
  }

  // Build array field
  buildArrayField = (
    key: string,
    schema: JSONSchema,
    values: any[]
  ): HTMLElement => {
    const labelText = toLabel(key, schema)
    const itemSchema = schema.items!

    const itemsContainer = div({ class: 'array-items' })

    // Get default value for a union schema variant
    const getUnionDefault = (unionSchema: JSONSchema): any => {
      if (unionSchema?.type === 'object' && unionSchema.properties) {
        const defaultValue: Record<string, any> = {}
        for (const [propKey, propSchema] of Object.entries(
          unionSchema.properties
        )) {
          if (propSchema.const !== undefined) {
            defaultValue[propKey] = propSchema.const
          } else if (propSchema.enum && propSchema.enum.length === 1) {
            defaultValue[propKey] = propSchema.enum[0]
          }
        }
        return defaultValue
      }
      return ''
    }

    // Get label for a union variant (from title or discriminator value)
    const getUnionLabel = (unionSchema: JSONSchema): string => {
      if (unionSchema.title) return unionSchema.title
      if (unionSchema.type === 'object' && unionSchema.properties) {
        for (const propSchema of Object.values(unionSchema.properties)) {
          if (propSchema.const !== undefined) {
            return String(propSchema.const)
          } else if (propSchema.enum && propSchema.enum.length === 1) {
            return String(propSchema.enum[0])
          }
        }
      }
      return 'Item'
    }

    const addItem = (variantSchema?: JSONSchema) => {
      const index = itemsContainer.children.length
      let defaultValue: any

      if (itemSchema.anyOf && variantSchema) {
        defaultValue = getUnionDefault(variantSchema)
      } else if (itemSchema.anyOf) {
        defaultValue = getUnionDefault(itemSchema.anyOf[0])
      } else {
        defaultValue =
          itemSchema.type === 'object' ? {} : itemSchema.default ?? ''
      }
      itemsContainer.append(
        this.buildArrayItem(key, itemSchema, defaultValue, index)
      )
      this.handleChange()
    }

    const handleAddClick = (event: Event) => {
      if (itemSchema.anyOf && itemSchema.anyOf.length > 1) {
        // Show menu to choose union variant
        popMenu({
          target: event.target as HTMLElement,
          menuItems: itemSchema.anyOf.map((variant) => ({
            caption: getUnionLabel(variant),
            action: () => addItem(variant),
          })),
        })
      } else {
        addItem()
      }
    }

    // Add existing items
    values.forEach((val, index) => {
      itemsContainer.append(this.buildArrayItem(key, itemSchema, val, index))
    })

    return div(
      { class: 'array-field', 'data-key': key },
      label({ class: 'array-label' }, labelText),
      itemsContainer,
      button(
        {
          type: 'button',
          class: 'add-item row',
          onClick: handleAddClick,
        },
        icons.plus(),
        span('Add')
      )
    )
  }

  // For union types, find the matching schema based on discriminator
  findUnionSchema = (
    anyOf: JSONSchema[],
    value: any
  ): JSONSchema | undefined => {
    if (!value || typeof value !== 'object') {
      return anyOf[0] // Default to first schema
    }
    // Look for discriminated union (matching by a property value)
    for (const schema of anyOf) {
      if (schema.type === 'object' && schema.properties) {
        // Check if all const/enum properties match
        let matches = true
        for (const [propKey, propSchema] of Object.entries(schema.properties)) {
          if (propSchema.const !== undefined) {
            if (value[propKey] !== propSchema.const) {
              matches = false
              break
            }
          } else if (
            propSchema.enum &&
            propSchema.enum.length === 1 &&
            value[propKey] !== propSchema.enum[0]
          ) {
            matches = false
            break
          }
        }
        if (matches) return schema
      }
    }
    return anyOf[0] // Default to first schema
  }

  // Build single array item
  buildArrayItem = (
    key: string,
    itemSchema: JSONSchema,
    value: any,
    index: number
  ): HTMLElement => {
    let content: HTMLElement

    // Handle union types (anyOf)
    if (itemSchema.anyOf) {
      const matchedSchema = this.findUnionSchema(itemSchema.anyOf, value)
      if (matchedSchema?.type === 'object' && matchedSchema.properties) {
        content = this.buildObjectField(
          `${key}[${index}]`,
          matchedSchema,
          value || {}
        )
      } else {
        // Fallback for non-object unions
        content = input({
          value: value ?? '',
          type: 'text',
          onChange: this.handleChange,
        })
      }
    } else if (itemSchema.type === 'object' && itemSchema.properties) {
      content = this.buildObjectField(`${key}[${index}]`, itemSchema, value)
    } else if (itemSchema.enum) {
      content = xinSelect({
        options: itemSchema.enum,
        value: value ?? '',
        placeholder: itemSchema.description || '-- Select --',
        onChange: this.handleChange,
      })
    } else {
      content = input({
        value: value ?? '',
        type: itemSchema.type === 'number' ? 'number' : 'text',
        onChange: this.handleChange,
      })
    }

    const removeItem = (e: Event) => {
      const item = (e.target as HTMLElement).closest('.array-item')
      item?.remove()
      this.handleChange()
    }

    return div(
      { class: 'array-item', 'data-index': index },
      content,
      button(
        {
          type: 'button',
          class: 'remove-item iconic',
          title: 'Remove',
          onClick: removeItem,
        },
        icons.trash()
      )
    )
  }

  // Build nested object field
  buildObjectField = (
    key: string,
    schema: JSONSchema,
    value: Record<string, any>
  ): HTMLElement => {
    const labelText = toLabel(key, schema)

    return fieldset(
      { class: 'object-field', 'data-key': key },
      legend(labelText),
      ...Object.entries(schema.properties || {})
        .filter(([propKey, propSchema]) => shouldShowField(propKey, propSchema))
        .map(([propKey, propSchema]) =>
          this.buildField(propKey, propSchema, schema, value[propKey])
        )
    )
  }

  content = () => {
    return div(
      { part: 'container' },
      form({
        class: 'schema-editor-form',
        onSubmit: (e: Event) => e.preventDefault(),
      })
    )
  }

  render() {
    super.render()

    const { container } = this.parts
    const formEl = container.querySelector('form')
    if (!formEl) return

    const { schema, value } = this

    // Clear and rebuild
    formEl.innerHTML = ''

    if (!schema.properties) {
      formEl.textContent = 'No schema properties defined'
      return
    }

    Object.entries(schema.properties)
      .filter(([key, propSchema]) => shouldShowField(key, propSchema))
      .forEach(([key, propSchema]) => {
        formEl.append(this.buildField(key, propSchema, schema, value[key]))
      })
  }
}

export const schemaEditor = SchemaEditor.elementCreator({
  tag: 'schema-editor',
  styleSpec: {
    ':host': {
      display: 'block',
    },
    ':host .schema-editor-form': {
      display: 'flex',
      flexDirection: 'column',
      gap: vars.spacing50,
    },
    ':host .field': {
      display: 'grid',
      gridTemplateColumns: '100px 1fr',
      alignItems: 'center',
      gap: vars.spacing25,
    },
    ':host .field label': {
      display: 'contents',
    },
    ':host .field label > span:first-child': {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: '0.9em',
    },
    ':host .field input, :host .field select, :host .field xin-select': {
      padding: vars.spacing25,
      borderRadius: vars.roundedRadius,
      border: `1px solid ${vars.borderColor}`,
    },
    ':host .required': {
      color: vars.errorColor,
    },
    ':host .array-field': {
      display: 'flex',
      flexDirection: 'column',
      gap: vars.spacing25,
      padding: vars.spacing50,
      border: `1px solid ${vars.borderColor}`,
      borderRadius: vars.roundedRadius,
    },
    ':host .array-label': {
      fontWeight: 'bold',
    },
    ':host .array-items': {
      display: 'flex',
      flexDirection: 'column',
      gap: vars.spacing25,
    },
    ':host .array-item': {
      display: 'flex',
      alignItems: 'center',
      gap: vars.spacing25,
    },
    ':host .array-item > *:first-child': {
      flex: 1,
    },
    ':host .add-item': {
      alignSelf: 'flex-start',
      display: 'flex',
      alignItems: 'center',
      gap: vars.spacing25,
    },
    ':host .remove-item': {
      flexShrink: 0,
    },
    ':host .object-field': {
      padding: vars.spacing50,
      border: `1px solid ${vars.borderColor}`,
      borderRadius: vars.roundedRadius,
    },
    ':host .object-field legend': {
      fontWeight: 'bold',
      padding: `0 ${vars.spacing25}`,
    },
  },
}) as ElementCreator<SchemaEditor>
