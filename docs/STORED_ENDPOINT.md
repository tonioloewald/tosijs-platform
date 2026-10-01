# Storage File Endpoint

The `/stored` endpoint serves files from the **legacy folders** of the default Cloud Storage
bucket (`blog/`, `public/`, `users/`) via simple URL paths.

> **New files belong in storage areas (`/blob`).** As of 0.3.0, files with their own access rules
> live in storage areas (DECISIONS D21, BETA.md "Store files"). `/stored` remains for the existing
> `blog/` and `public/` files and the links that point at them.

## Overview

Instead of generating signed URLs client-side or using the Firebase Storage SDK, you can directly embed storage files using simple paths like `/stored/blog/image.webp`.

## Usage

```html
<!-- Direct in HTML -->
<img src="/stored/blog/photo.webp" alt="Photo">
<video src="/stored/blog/demo.mp4" controls></video>
<a href="/stored/public/document.pdf">Download PDF</a>
```

```typescript
// Or construct URLs programmatically
import { pathToStoredUrl } from './firebase'

const imageUrl = pathToStoredUrl('blog/photo.webp')
// Returns: '/stored/blog/photo.webp'
```

## How It Works

1. Request comes to `/stored/{path}`
2. The path is percent-decoded and must lie inside a legacy folder (`blog/`, `public/`, `users/`;
   `LEGACY_FOLDERS` in `functions/src/legacy-storage.ts`). Anything else is a 404, exactly like a
   missing file.
3. Function looks up the file in the project's **default bucket**
4. If the host can sign URLs: redirects to a signed URL (1 hour expiry)
5. Otherwise (the emulator, or a functions service account without "Service Account Token
   Creator"): streams the file directly

## Caching

- Signed URLs expire after 1 hour
- Response includes `Cache-Control: public, max-age=3300` (55 minutes)
- Browsers and CDNs cache the redirect, avoiding repeated function calls
- Subsequent requests within the cache window don't hit the function

## MIME Types

The endpoint determines content types from:
1. File metadata stored in Firebase Storage
2. Fallback to extension-based detection if metadata is `application/octet-stream`

Supported extensions include images (webp, png, jpg, gif, svg, avif), video (mp4, webm, mov), audio (mp3, wav, ogg), documents (pdf), and more. See `functions/shared/mime-types.ts` for the complete list.

## Error Responses

| Status | Reason |
|--------|--------|
| 400 | Not a `/stored/...` URL |
| 404 | File not found, or not in a legacy folder (indistinguishable on purpose) |
| 500 | Error reading file |

## Configuration

The endpoint is configured in `firebase.json`:

```json
{
  "hosting": {
    "rewrites": [
      {
        "source": "/stored/**",
        "function": "stored"
      }
    ]
  }
}
```

## Asset Manager Integration

The Asset Manager component uses `/stored` URLs when inserting images and media:

```typescript
// When you click "Insert <img>" in the asset manager:
<img alt="photo" src="/stored/blog/photo.webp" style="aspect-ratio: 1920 / 1080; width: 1920px;">
```

The asset manager automatically:
- Detects image/video dimensions for aspect-ratio styling
- Generates appropriate HTML for images, video, and audio
- Copies `/stored` URLs to clipboard

## Emulator Support

The Firebase Storage emulator doesn't support `getSignedUrl()`, so the function falls back to streaming the file directly. This is transparent to the client. Production does the same when the functions service account cannot sign URLs.

## Security

`/stored` uses the **Admin SDK, so `storage.rules` never applies to it.** It shares the bucket
with `/blob`'s storage areas, which have their own access rules. So it reads only an ALLOWLIST of
legacy folders. A denylist of area keys missed exactly this reader in the 0.3.0 review. To add a
folder, change both `functions/src/legacy-storage.ts` and `storage.rules`; a test checks they agree.

Streamed files come from the site's own origin, so they are sent `nosniff`, and Hosting applies a
sandbox CSP to `/stored/**` (an uploaded SVG cannot run script as the site). The function's own
CSP is replaced by Hosting's, which is why the rule lives in `firebase.json`.

## See Also

- [functions/src/stored.ts](../functions/src/stored.ts) - Endpoint implementation
- [functions/shared/mime-types.ts](../functions/shared/mime-types.ts) - MIME type utilities
- [src/asset-manager.ts](../src/asset-manager.ts) - Asset manager component
