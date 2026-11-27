/**
 * Browser-side media helpers for the asset manager: an image's or video's
 * dimensions (so inserted HTML reserves its space and the page does not shift),
 * and converting an image to webP before upload.
 */
import type { MediaType } from '../../functions/shared/mime-types.js'

export interface Dimensions {
  width: number
  height: number
}

/** Load an image and return its natural dimensions. */
export const getImageDimensions = (url: string): Promise<Dimensions> =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`))
    img.src = url
  })

/** Load a video's metadata and return its dimensions. */
export const getVideoDimensions = (url: string): Promise<Dimensions> =>
  new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.onloadedmetadata = () =>
      resolve({ width: video.videoWidth, height: video.videoHeight })
    video.onerror = () =>
      reject(new Error(`Failed to load video metadata: ${url}`))
    video.src = url
  })

export const getDimensions = (
  url: string,
  type: MediaType
): Promise<Dimensions> =>
  type === 'image' ? getImageDimensions(url) : getVideoDimensions(url)

/**
 * A style attribute (with its leading space) giving the aspect ratio and
 * width, or '' when the dimensions cannot be had.
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

/**
 * The image as webP, scaled so its longer side is at most `maxSize`. Resolves
 * to the original file when the browser cannot decode or encode it.
 */
export const imageToWebP = (
  file: Blob,
  quality = 0.9,
  maxSize = 2160
): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      if (!e.target) {
        resolve(file)
        return
      }
      const img = new Image()
      img.onload = () => {
        const longer = Math.max(img.width, img.height)
        const scale = longer > maxSize ? maxSize / longer : 1
        const canvas = document.createElement('canvas')
        canvas.width = img.width * scale
        canvas.height = img.height * scale
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(file)
          return
        }
        ctx.drawImage(
          img,
          0,
          0,
          img.width,
          img.height,
          0,
          0,
          canvas.width,
          canvas.height
        )
        canvas.toBlob((blob) => resolve(blob ?? file), 'image/webp', quality)
      }
      img.onerror = () => resolve(file)
      img.src = e.target.result as string
    }
    reader.onerror = (err) => reject(err)
    reader.readAsDataURL(file)
  })
