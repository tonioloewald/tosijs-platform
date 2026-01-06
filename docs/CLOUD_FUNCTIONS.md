# Cloud Functions

This project uses Firebase Cloud Functions v2 (2nd generation) exclusively. V2 functions run on Cloud Run and provide better performance, concurrency, and importantly, native support for Secret Manager.

## Why v2 Functions?

- **Secret Manager integration** - Secure handling of API keys and credentials
- **Better concurrency** - Multiple requests per instance
- **Longer timeouts** - Up to 60 minutes
- **More memory options** - Up to 32GB
- **Cloud Run backing** - More control over container behavior

## Basic Structure

All functions follow this pattern:

```typescript
import { onRequest } from 'firebase-functions/v2/https'
import { optionsResponse } from './utilities'

export const myFunction = onRequest({}, async (req, res) => {
  // Handle CORS preflight
  if (optionsResponse(req, res)) {
    return
  }

  // Your logic here
  res.json({ result: 'success' })
})
```

## Examples

### Simple Endpoint: `hello.ts`

The simplest example of a v2 function:

```typescript
import { onRequest } from 'firebase-functions/v2/https'
import compression from 'compression'
import { optionsResponse, getUser, getUserRoles, timestamp } from './utilities'

const compressResponse = compression()

export const hello = onRequest({}, async (req, res) => {
  if (optionsResponse(req, res)) {
    return
  }
  
  const user = await getUser(req)
  const userRoles = await getUserRoles(req)

  compressResponse(req, res, () => {
    res.json({
      result: `hello ${req.query.name || 'to you'} too!`,
      timestamp: timestamp(),
      user,
      userRoles,
    })
  })
})
```

Key points:
- Import `onRequest` from `firebase-functions/v2/https`
- Use `optionsResponse()` to handle CORS preflight requests
- Use `compression` middleware for response compression
- Access user info via `getUser()` and `getUserRoles()` utilities

### Using Secrets: `gen.ts`

For functions that need API keys or other sensitive data, use Secret Manager:

```typescript
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { optionsResponse, getUserRoles } from './utilities'

// Define secrets at module level
const geminiApiKey = defineSecret('gemini-api-key')
const chatgptApiKey = defineSecret('chatgpt-api-key')

export const gen = onRequest(
  // Pass secrets in the options object
  { secrets: [geminiApiKey, chatgptApiKey] },
  async (req, res) => {
    if (optionsResponse(req, res)) {
      return
    }

    // Access secret values inside the handler
    const apiKey = geminiApiKey.value()
    
    // Use the secret...
  }
)
```

Key points:
- Import `defineSecret` from `firebase-functions/params`
- Define secrets at module level with `defineSecret('secret-name')`
- Pass secrets array in the function options: `{ secrets: [mySecret] }`
- Access values inside the handler with `mySecret.value()`
- **Never** use environment variables for sensitive data

### Setting Up Secrets

```bash
# Create a new secret
firebase functions:secrets:set my-api-key

# View secret versions
firebase functions:secrets:get my-api-key

# Destroy a secret
firebase functions:secrets:destroy my-api-key
```

Secrets are stored in Google Cloud Secret Manager and automatically injected into your function at runtime.

## Best Practices

### Do

- Use v2 functions (`firebase-functions/v2/https`)
- Use Secret Manager for all sensitive data
- Handle CORS with `optionsResponse()`
- Use compression for JSON responses
- Validate user authentication with `getUserRoles()`

### Don't

- Use environment variables for secrets
- Use v1 functions (`firebase-functions/https`)
- Store API keys in code or config files
- Skip CORS handling

## Exporting Functions

Add your function to `functions/src/index.ts`:

```typescript
export { myFunction } from './my-function'
```

## Routing

Configure URL routing in `firebase.json`:

```json
{
  "hosting": {
    "rewrites": [
      {
        "source": "/my-endpoint/**",
        "function": "myFunction"
      }
    ]
  }
}
```

## Deployment

```bash
# Deploy all functions
firebase deploy --only functions

# Deploy a specific function
firebase deploy --only functions:myFunction
```

## Common Utilities

From `functions/src/utilities.ts`:

| Function | Purpose |
|----------|---------|
| `optionsResponse(req, res)` | Handle CORS preflight, returns true if handled |
| `getUser(req)` | Get authenticated user from token |
| `getUserRoles(req)` | Get user's roles for access control |
| `timestamp()` | Current ISO timestamp |

## See Also

- [functions/src/hello.ts](../functions/src/hello.ts) - Simple endpoint example
- [functions/src/gen.ts](../functions/src/gen.ts) - Secrets example
- [functions/src/stored.ts](../functions/src/stored.ts) - Storage access example
- [FIRESTORE_API.md](./FIRESTORE_API.md) - Database access patterns
