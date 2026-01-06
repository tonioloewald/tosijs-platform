// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { test, expect } from 'bun:test'
import { DOCTYPE, elements, escapeHTMLAttribute } from './elements'

test('void elements', () => {
  expect(elements.input()).toBe('<input>')
  expect(elements.input({ class: 'foo' })).toBe('<input class="foo">')
  expect(elements.input({ dataTest: 'foo' })).toBe('<input data-test="foo">')
})

test('elements', () => {
  expect(elements.div()).toBe('<div></div>')
  expect(elements.div({ class: 'foo' })).toBe('<div class="foo"></div>')
  expect(elements.div({ dataTest: 'foo' })).toBe('<div data-test="foo"></div>')
  expect(elements.div({ class: 'foo' }, elements.input())).toBe(
    '<div class="foo"><input></div>'
  )
})

test('element text', () => {
  expect(elements.div('foo bar')).toBe('<div>foo bar</div>')
  expect(elements.div(elements.span('foo'), 'bar')).toBe(
    '<div><span>foo</span>bar</div>'
  )
  expect(elements.script('let x = 17')).toBe('<script>let x = 17</script>')
})

test('properties', () => {
  expect(elements.input({ hidden: true, dataBlah: 'blah' })).toBe(
    '<input hidden data-blah="blah">'
  )
  expect(elements.input({ hidden: false, dataBlah: 'blah' })).toBe(
    '<input data-blah="blah">'
  )
})

test('custom-elements', () => {
  expect(elements.fooBar()).toBe('<foo-bar></foo-bar>')
})

test('page', () => {
  const { html, head, body, title } = elements
  expect(DOCTYPE + html(head(title('foobar')), body())).toBe(
    '<!DOCTYPE html><html><head><title>foobar</title></head><body></body></html>'
  )
})

test('html attributes are escapted properly', () => {
  expect(escapeHTMLAttribute('This is a "test"')).toBe(
    'This is a &quot;test&quot;'
  )
  expect(escapeHTMLAttribute("This 'is' a test")).toBe(
    'This &apos;is&apos; a test'
  )
  expect(
    elements.button({
      title:
        'When this baby hits 88MPH you\'re going to see some "serious shit"',
    })
  ).toBe(
    '<button title="When this baby hits 88MPH you&apos;re going to see some &quot;serious shit&quot;"></button>'
  )
})
