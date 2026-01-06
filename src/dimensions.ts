/**
 * Utilities for getting dimensions of media elements (images, videos).
 * These are useful for setting aspect-ratio styles to prevent layout shift.
 */

import { MediaType } from '../functions/shared/mime-types'

export interface Dimensions {
  width: number
  height: number
}

/**
 * Load an image and return its natural dimensions.
 */
export const getImageDimensions = (url: string): Promise<Dimensions> => {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      reject(new Error(`Failed to load image: ${url}`))
    }
    img.src = url
  })
}

/**
 * Load video metadata and return its dimensions.
 */
export const getVideoDimensions = (url: string): Promise<Dimensions> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight })
    }
    video.onerror = () => {
      reject(new Error(`Failed to load video metadata: ${url}`))
    }
    video.src = url
  })
}

/**
 * Get dimensions for an image or video URL.
 */
export const getDimensions = (
  url: string,
  type: MediaType
): Promise<Dimensions> => {
  return type === 'image' ? getImageDimensions(url) : getVideoDimensions(url)
}

/**
 * Generate a style attribute string with aspect-ratio and width.
 * Returns empty string if dimensions cannot be determined.
 */
export const getDimensionsStyleAttr = async (
  url: string,
  type: MediaType
): Promise<string> => {
  try {
    const { width, height } = await getDimensions(url, type)
    return ` style="aspect-ratio: ${width} / ${height}; width: ${width}px;"`
  } catch (e) {
    console.warn('Could not get dimensions:', e)
    return ''
  }
}
