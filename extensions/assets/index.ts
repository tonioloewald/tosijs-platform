/**
 * `service-compris/assets` — the asset manager, an installable extension of
 * the core (D28).
 *
 * A host gets it in two parts:
 *
 * 1. **Storage.** Install `service-compris/assets/manifest.json`
 *    (`bun scripts/install-manifest.js …`) for two general storage areas,
 *    `assets:public` and `assets:private`, or use areas another manifest
 *    already declares (loewald.com uses the blog's).
 * 2. **The component.** In the browser, with tosijs and tosijs-ui installed
 *    (optional peer dependencies of this package):
 *
 * ```ts
 * import { assetManager, blobFiles } from 'service-compris/assets'
 *
 * document.body.append(
 *   assetManager({
 *     files: blobFiles({ serviceUrl: 'https://example.com/', getToken: (refresh) => user?.getIdToken(refresh) }),
 *     folders: ['assets:public', 'assets:private'],
 *   })
 * )
 * ```
 *
 * The root `service-compris` import stays DOM-free; only this one needs a
 * browser.
 *
 * @packageDocumentation
 */

export {
  AssetManager,
  assetManager,
  escapeHTMLAttribute,
} from './asset-manager.js'
export { blobFiles, type BlobFilesOptions } from './blob-files.js'
export {
  cleanName,
  cleanPath,
  fileKind,
  locate,
  type Asset,
  type AssetFiles,
  type FileKind,
  type FileLocation,
} from './files.js'
export {
  getDimensions,
  getDimensionsStyleAttr,
  imageToWebP,
  type Dimensions,
} from './media.js'
