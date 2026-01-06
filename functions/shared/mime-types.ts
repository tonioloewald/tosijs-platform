/**
 * MIME type utilities for file extension mapping.
 *
 * This module provides a centralized mapping of file extensions to MIME types,
 * along with helper functions for determining file types and getting MIME types.
 */

export const MIME_TYPES: Record<string, string> = {
  // Images
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',

  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',

  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',

  // Documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  // Text/Code
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  xml: 'application/xml',
  csv: 'text/csv',

  // Archives
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',

  // Fonts
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
}

export type MediaType = 'image' | 'video' | 'audio' | 'other'

/**
 * Get the file extension from a path or filename.
 */
export const getExtension = (path: string): string =>
  path.split('.').pop()?.toLowerCase() || ''

/**
 * Get the MIME type for a file path or filename.
 * Returns 'application/octet-stream' for unknown extensions.
 */
export const getMimeType = (path: string): string =>
  MIME_TYPES[getExtension(path)] || 'application/octet-stream'

/**
 * Get the media type category for a file path or filename.
 * Returns 'image', 'video', 'audio', or 'other'.
 */
export const getMediaType = (path: string): MediaType => {
  const mimeType = getMimeType(path)
  const category = mimeType.split('/')[0]
  if (category === 'image' || category === 'video' || category === 'audio') {
    return category
  }
  return 'other'
}

/**
 * Check if a file is of a specific media type.
 */
export const isImage = (path: string): boolean => getMediaType(path) === 'image'
export const isVideo = (path: string): boolean => getMediaType(path) === 'video'
export const isAudio = (path: string): boolean => getMediaType(path) === 'audio'
