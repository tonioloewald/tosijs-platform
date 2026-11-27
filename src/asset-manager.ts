/**
 * This site's asset manager: the assets extension (`extensions/assets`,
 * published as `service-compris/assets`), configured for loewald.com.
 *
 * Its files live in two places. `blog:public` is a storage area (the blog
 * manifest's), served by /blob; `public` is a legacy Storage folder, not
 * migrated yet (board #2486), still read through /stored and written with the
 * Storage SDK. The old `blog` folder's files were copied into the area and
 * still serve from /stored. The legacy folder is this site's, not the
 * extension's, so its handling lives here.
 */
import {
  getStorage,
  ref as storageRef,
  getBytes,
  getMetadata,
  uploadBytes,
  listAll,
  deleteObject,
} from 'firebase/storage'
import type { CodeEditor } from 'tosijs-ui/code-editor'
import {
  assetManager as createAssetManager,
  blobFiles,
  locate,
  type AssetFiles,
} from '../extensions/assets/index.js'
import { baseServiceUrl, getFirebaseUser } from './firebase'

const areas = blobFiles({
  serviceUrl: baseServiceUrl,
  getToken: (refresh) => getFirebaseUser()?.getIdToken(refresh),
})

const legacy = (path: string) => storageRef(getStorage(), path)

/** Storage areas through /blob; any other folder through the Storage SDK. */
export const siteFiles: AssetFiles = {
  async list(folder) {
    if (locate(folder).area) return areas.list(folder)
    const { items } = await listAll(legacy(folder))
    return items.map((item) => ({ name: item.name, path: item.fullPath }))
  },

  async upload(body, path) {
    if (locate(path).area) return areas.upload(body, path)
    const { metadata } = await uploadBytes(legacy(path), body)
    return metadata.fullPath
  },

  async remove(path) {
    if (locate(path).area) return areas.remove(path)
    try {
      await deleteObject(legacy(path))
      return true
    } catch (e) {
      return false
    }
  },

  async move(from, to) {
    const fromArea = locate(from).area
    const toArea = locate(to).area
    if (fromArea && toArea) return areas.move(from, to)
    // Legacy ↔ area is not a rename (that is the migration's `import`).
    if (fromArea || toArea) return false
    try {
      const metadata = await getMetadata(legacy(from))
      const bytes = await getBytes(legacy(from))
      await uploadBytes(legacy(to), bytes, {
        contentType: metadata.contentType,
        customMetadata: metadata.customMetadata,
      })
      await deleteObject(legacy(from))
      return true
    } catch (e) {
      console.error('Error renaming file:', e)
      return false
    }
  },

  url(path) {
    const { area, folder, name } = locate(path)
    return area ? areas.url(path) : `/stored/${folder}/${name}`
  },
}

export const assetManager = () =>
  createAssetManager({
    files: siteFiles,
    folders: ['blog:public', 'public'],
    insertInto: () =>
      document.querySelector('xin-post-editor tosi-code') as CodeEditor | null,
  })
