# Storage File Endpoint

The `/stored` endpoint serves files from Firebase Cloud Storage via simple URL paths.

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
2. Function looks up the file in Firebase Storage at `gs://bucket/{path}`
3. In production: redirects to a signed URL (1 hour expiry)
4. In emulator: streams the file directly (signed URLs not supported)

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
| 400 | Invalid storage path |
| 404 | File not found |
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

The Firebase Storage emulator doesn't support `getSignedUrl()`, so the function falls back to streaming the file directly. This is transparent to the client.

## Security

Files are served based on Firebase Storage security rules. Currently configured for public read access. Modify `storage.rules` to restrict access if needed.

## See Also

- [functions/src/stored.ts](../functions/src/stored.ts) - Endpoint implementation
- [functions/shared/mime-types.ts](../functions/shared/mime-types.ts) - MIME type utilities
- [src/asset-manager.ts](../src/asset-manager.ts) - Asset manager component
