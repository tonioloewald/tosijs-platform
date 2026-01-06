/**
 * Role Manager Component
 *
 * A floating window for managing user roles. Provides CRUD operations
 * for role records using the schema-driven editor.
 */

import {
  Component,
  ElementCreator,
  PartsMap,
  elements,
  vars,
  varDefault,
  getListItem,
  tosi,
} from 'tosijs'
import {
  xinFloat,
  xinSizer,
  icons,
  postNotification,
  TosiDialog,
} from 'tosijs-ui'
import { SchemaEditor, schemaEditor } from './schema-editor'
import { RoleSchema, Role, emptyRole } from '../functions/shared/role'
import * as fb from './firebase'

const { h4, button, div, span, template, input } = elements

// Custom binding for show/hide based on boolean value
const showBinding = {
  toDOM(element: HTMLElement, value: boolean) {
    element.style.display = value ? '' : 'none'
  },
}

// Inverse of showBinding - hide when true, show when false
const hideBinding = {
  toDOM(element: HTMLElement, value: boolean) {
    element.style.display = value ? 'none' : ''
  },
}

const { roleManagerData } = tosi({
  roleManagerData: {
    roles: [] as Role[],
    filter: '',
    selectedRole: null as Role | null,
    isEditing: false,
    isExistingRole: false,
    editingTitle: 'New Role',
  },
})

// Filter function for role list
const filterRoles = (roles: Role[], needle: string): Role[] => {
  needle = needle.trim().toLocaleLowerCase()
  if (!needle) {
    return roles
  }
  return roles.filter(
    (role: Role) =>
      role.name.toLocaleLowerCase().includes(needle) ||
      role.roles.some((r) => r.toLocaleLowerCase().includes(needle))
  )
}

interface RoleManagerParts extends PartsMap {
  search: HTMLInputElement
  roleList: HTMLElement
  editor: SchemaEditor
  listView: HTMLElement
  editView: HTMLElement
  editTitle: HTMLElement
  deleteBtn: HTMLButtonElement
}

class RoleManager extends Component<RoleManagerParts> {
  private originalPath = ''

  loadRoles = async () => {
    try {
      console.log('Loading roles...')
      const roles = await fb.service.docs.get({ p: 'role' })
      console.log('Loaded roles:', roles)
      roleManagerData.roles.xinValue = roles || []
    } catch (e) {
      console.error('Failed to load roles:', e)
      postNotification({
        type: 'error',
        message: `Failed to load roles: ${e}`,
      })
    }
  }

  selectRole = (role: Role) => {
    roleManagerData.selectedRole.xinValue = { ...role }
    roleManagerData.editingTitle.xinValue = `Edit: ${role.name}`
    roleManagerData.isEditing.xinValue = true
    roleManagerData.isExistingRole.xinValue = true
    this.originalPath = (role as any)._path || ''
    const { editor } = this.parts
    if (editor) {
      editor.value = { ...role }
    }
  }

  createNew = () => {
    roleManagerData.selectedRole.xinValue = null
    roleManagerData.editingTitle.xinValue = 'New Role'
    roleManagerData.isEditing.xinValue = true
    roleManagerData.isExistingRole.xinValue = false
    this.originalPath = ''
    const { editor } = this.parts
    if (editor) {
      editor.value = { ...emptyRole }
    }
  }

  cancelEdit = () => {
    roleManagerData.isEditing.xinValue = false
    roleManagerData.selectedRole.xinValue = null
    roleManagerData.isExistingRole.xinValue = false
  }

  saveRole = async () => {
    const { editor } = this.parts
    if (!editor) return

    if (!editor.reportValidity()) {
      return
    }

    const editorValue = editor.value as Role

    const closeNotification = postNotification({
      type: 'progress',
      message: 'Saving role...',
    })

    try {
      const isNew = !roleManagerData.isExistingRole.xinValue

      if (isNew) {
        // Generate ID from name
        const id =
          editorValue.name.toLowerCase().replace(/[^\w]+/g, '-') + '-role'
        await fb.service.doc.post({
          p: `role/${id}`,
          data: editorValue,
        })
        postNotification({
          type: 'info',
          message: `Role "${editorValue.name}" created`,
          duration: 3,
        })
      } else {
        await fb.service.doc.put({
          p: this.originalPath,
          data: editorValue,
        })
        postNotification({
          type: 'info',
          message: `Role "${editorValue.name}" updated`,
          duration: 3,
        })
      }

      await this.loadRoles()
      this.cancelEdit()
    } catch (e) {
      postNotification({
        type: 'error',
        message: `Failed to save role: ${e}`,
      })
    } finally {
      closeNotification()
    }
  }

  deleteRole = async () => {
    if (!this.originalPath) return

    const selectedRole = roleManagerData.selectedRole.xinValue as Role | null
    const confirmed = await TosiDialog.confirm(
      `Delete role "${selectedRole?.name}"? This cannot be undone.`
    )
    if (!confirmed) return

    const closeNotification = postNotification({
      type: 'progress',
      message: 'Deleting role...',
    })

    try {
      await fb.service.doc.delete({ p: this.originalPath })
      postNotification({
        type: 'info',
        message: `Role "${selectedRole?.name}" deleted`,
        duration: 3,
      })
      await this.loadRoles()
      this.cancelEdit()
    } catch (e) {
      postNotification({
        type: 'error',
        message: `Failed to delete role: ${e}`,
      })
    } finally {
      closeNotification()
    }
  }

  handleRoleClick = (event: Event) => {
    const target = event.target as HTMLElement
    const item = getListItem(target)
    if (item) {
      this.selectRole(item as Role)
    }
  }

  content = () =>
    xinFloat(
      {
        class: 'compact',
        drag: true,
        style: {
          bottom: '10px',
          right: '10px',
          maxWidth: 'calc(100% - 20px)',
          minHeight: '400px',
          minWidth: '400px',
          width: '500px',
          overflow: 'hidden',
        },
      },
      h4('Role Manager', {
        class: 'primary',
        style: { textAlign: 'center', padding: vars.spacing75, margin: 0 },
      }),

      // List view
      div(
        {
          part: 'listView',
          class: 'list-view',
          bind: { value: roleManagerData.isEditing, binding: hideBinding },
        },
        div(
          { class: 'row no-drag', style: { padding: vars.spacing50 } },
          input({
            part: 'search',
            type: 'search',
            placeholder: 'filter roles',
            bindValue: roleManagerData.filter,
            class: 'elastic',
          }),
          button(
            {
              class: 'row',
              style: { marginLeft: vars.spacing50 },
              onClick: this.createNew,
            },
            icons.plus(),
            span('New')
          )
        ),
        div(
          {
            part: 'roleList',
            class: 'column elastic no-drag',
            style: {
              height: '300px',
              overflow: 'hidden scroll',
              alignItems: 'stretch',
              margin: `0 ${vars.spacing50}`,
            },
            bindList: {
              value: roleManagerData.roles,
              filter: filterRoles,
              needle: roleManagerData.filter,
            },
          },
          template(
            div(
              {
                class: 'role-item row',
                onClick: this.handleRoleClick,
              },
              span({ class: 'role-name elastic', bindText: '^.name' }),
              span({
                class: 'role-roles text-muted',
                bindText: '^.roles',
              })
            )
          )
        )
      ),

      // Edit view
      div(
        {
          part: 'editView',
          class: 'edit-view no-drag',
          bind: { value: roleManagerData.isEditing, binding: showBinding },
        },
        div(
          {
            class: 'editor-header row',
            style: { padding: vars.spacing50 },
          },
          button(
            {
              class: 'iconic',
              title: 'Back to list',
              onClick: this.cancelEdit,
            },
            icons.arrowLeft()
          ),
          span({
            part: 'editTitle',
            class: 'elastic',
            style: { fontWeight: 'bold' },
            bindText: roleManagerData.editingTitle,
          })
        ),
        div(
          {
            class: 'editor-container',
            style: {
              padding: vars.spacing50,
              overflow: 'auto',
              maxHeight: '350px',
            },
          },
          schemaEditor({
            part: 'editor',
            schema: RoleSchema.schema,
            value: emptyRole,
          })
        ),
        div(
          {
            class: 'editor-actions row',
            style: {
              padding: vars.spacing50,
              justifyContent: 'flex-end',
              gap: vars.spacing50,
            },
          },
          button(
            {
              part: 'deleteBtn',
              class: 'danger',
              onClick: this.deleteRole,
              bind: {
                value: roleManagerData.isExistingRole,
                binding: showBinding,
              },
            },
            icons.trash(),
            span('Delete')
          ),
          span({ class: 'elastic' }),
          button(
            {
              onClick: this.cancelEdit,
            },
            'Cancel'
          ),
          button(
            {
              class: 'primary',
              onClick: this.saveRole,
            },
            icons.save(),
            span('Save')
          )
        )
      ),

      xinSizer({ class: 'no-drag' }),
      button(
        {
          title: 'close role manager',
          class: 'iconic no-drag',
          style: {
            position: 'absolute',
            top: 0,
            right: 0,
          },
          onClick: this.remove.bind(this),
        },
        icons.x()
      )
    )

  connectedCallback() {
    super.connectedCallback()
    this.loadRoles()
  }
}

export const roleManager = RoleManager.elementCreator({
  tag: 'role-manager',
  styleSpec: {
    ':host': {
      _spacing: varDefault.pad('10px'),
    },
    ':host xin-sizer': {
      _resizeIconFill: vars.textColor,
    },
    ':host xin-float': {
      background: vars.panelBg,
      display: 'flex',
      flexDirection: 'column',
    },
    ':host .list-view, :host .edit-view': {
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
    },
    ':host .role-item': {
      padding: vars.spacing50,
      cursor: 'pointer',
      borderRadius: vars.roundedRadius,
    },
    ':host .role-item:hover': {
      background: vars.hoverBg,
    },
    ':host .role-name': {
      fontWeight: 500,
    },
    ':host .role-roles': {
      fontSize: '0.85em',
    },
    ':host .text-muted': {
      opacity: 0.7,
    },
    ':host .editor-container': {
      flex: 1,
    },
    ':host button': {
      display: 'inline-flex',
      gap: '0.5em',
      alignItems: 'center',
      justifyContent: 'center',
    },
    ':host button.danger': {
      color: vars.errorColor,
    },
  },
}) as ElementCreator<RoleManager>
