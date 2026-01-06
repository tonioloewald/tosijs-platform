/**
 * System fields that are automatically managed by the back-end.
 * These should be read-only and hidden in user-facing editors.
 */

import { s } from 'tosijs-schema'

// System field definitions with metadata for UI handling
export const systemFields = {
  _id: s.string.optional.title('ID').describe('Document ID (system-managed)'),
  _path: s.string.optional.title('Path').describe('Document path (system-managed)'),
  _created: s.string.optional.title('Created').describe('Creation timestamp (system-managed)'),
  _modified: s.string.optional.title('Modified').describe('Last modification timestamp (system-managed)'),
}

// List of system field names for easy checking
export const SYSTEM_FIELD_NAMES = ['_id', '_path', '_created', '_modified'] as const
export type SystemFieldName = (typeof SYSTEM_FIELD_NAMES)[number]

// Helper to check if a field name is a system field
export const isSystemField = (name: string): name is SystemFieldName => {
  return SYSTEM_FIELD_NAMES.includes(name as SystemFieldName)
}
