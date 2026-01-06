interface AttributeMap {
  [key: string]: string | number | boolean
}

type ElementCreator = (...children: Array<AttributeMap | string>) => string
interface ElementCreatorMap {
  [key: string]: ElementCreator
}

export const DOCTYPE = '<!DOCTYPE html>'

const VOID_TAGS = [
  'area',
  'base',
  'br',
  'col',
  'embed',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]

const elementCreators: ElementCreatorMap = {}

const camelToSnake = (key: string): string => {
  return key.replace(/([a-z])([A-Z])/g, '$1-$2').toLocaleLowerCase()
}

export const escapeHTMLAttribute = (value: string): string => {
  return value.replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

const renderAttributes = (children: Array<AttributeMap | string>): string => {
  const attributeMaps = children.filter(
    (child) => typeof child !== 'string'
  ) as AttributeMap[]
  return attributeMaps
    .map((attributeMap: AttributeMap) => {
      return Object.keys(attributeMap).map((attribute) => {
        const value = attributeMap[attribute]
        if (typeof value === 'boolean') {
          if (value) {
            return attribute
          } else {
            return ''
          }
        } else {
          return `${camelToSnake(attribute)}="${escapeHTMLAttribute(
            String(attributeMap[attribute])
          )}"`
        }
      })
    })
    .flat()
    .filter((s) => s !== '')
    .join(' ')
}

const renderChildren = (children: Array<AttributeMap | string>): string => {
  return children.filter((child) => typeof child === 'string').join('')
}

export const elements = new Proxy(elementCreators, {
  get(target: ElementCreatorMap, tag: string) {
    tag = camelToSnake(tag)
    if (!target[tag]) {
      target[tag] = VOID_TAGS.includes(tag)
        ? (...children: Array<AttributeMap | string>): string => {
            const attributes = renderAttributes(children)
            return `<${tag}${attributes ? ' ' : ''}${attributes}>`
          }
        : (...children: Array<AttributeMap | string>): string => {
            const attributes = renderAttributes(children)
            return `<${tag}${
              attributes ? ' ' : ''
            }${attributes}>${renderChildren(children)}</${tag}>`
          }
    }
    return target[tag]
  },
})
