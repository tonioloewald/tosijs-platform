import { Component as WebComponent, ElementCreator } from 'tosijs'

export class TosiEsm extends WebComponent {
  static preferredTagName = 'tosi-esm'
  module = ''
  version = ''
  method = ''
  passReference = false
  status: 'idle' | 'loading' | 'ready' | 'error' = 'idle'

  content = null

  constructor() {
    super()
    this.initAttributes(
      'module',
      'version',
      'status',
      'method',
      'passReference'
    )
  }

  async connectedCallback() {
    super.connectedCallback()

    if (!this.module) {
      return
    }

    const path = `/esm/${this.module}${this.version ? '@' + this.version : ''}`

    this.status = 'loading'

    try {
      const mod = await import(path)
      this.status = 'ready'

      if (this.method && typeof mod[this.method] === 'function') {
        if (this.passReference) {
          mod[this.method](this)
        } else {
          mod[this.method]()
        }
      }
    } catch (e) {
      console.error(`Failed to load module: ${path}`, e)
      this.status = 'error'
    }
  }
}

export const tosiEsm = TosiEsm.elementCreator() as ElementCreator<TosiEsm>
