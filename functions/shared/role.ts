import { s, type Infer } from 'tosijs-schema'
import { systemFields } from './system-fields'

export const EmailContactSchema = s.object({
  type: s.const('email'),
  value: s.email.title('Email').describe('Email address'),
})

export const PhoneContactSchema = s.object({
  type: s.const('phone'),
  value: s.string
    .pattern(/^\+?[\d\s\-\(\)\.]{7,}$/)
    .title('Phone')
    .describe('Phone number (e.g. +1 555-123-4567)'),
})

export const AddressContactSchema = s.object({
  type: s.const('address'),
  value: s.string.min(1).title('Address').describe('Mailing address'),
})

export const ContactSchema = s
  .union([EmailContactSchema, PhoneContactSchema, AddressContactSchema])
  .title('Contact')
  .describe('A contact method for role assignment')

export type Contact = Infer<typeof ContactSchema>

export const RoleSchema = s
  .object({
    ...systemFields,
    name: s.string.title('Name').describe('Display name for this role'),
    contacts: s
      .array(ContactSchema)
      .title('Contacts')
      .describe('Contact methods used to match users to this role'),
    roles: s
      .array(s.string)
      .title('Roles')
      .describe(
        'Permission roles assigned (owner, developer, admin, editor, author)'
      ),
    userIds: s
      .array(s.string)
      .title('User IDs')
      .describe('Firebase UIDs matched to this role (auto-populated)'),
  })
  .title('Role')
  .describe('User role assignment configuration')

export type Role = Infer<typeof RoleSchema>

export const emptyRole: Role = {
  name: '',
  contacts: [],
  roles: [],
  userIds: [],
}
