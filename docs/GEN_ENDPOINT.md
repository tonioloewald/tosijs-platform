# LLM Generation Endpoint

The `/gen` endpoint provides a simple interface for LLM text generation using Gemini or ChatGPT models.

> **Note**: This endpoint will be superseded by the `tosijs-agent` library which provides a more comprehensive agent-based approach.

> **Developer Note**: This function serves as the reference example for using Secret Manager with v2 Cloud Functions. See [CLOUD_FUNCTIONS.md](./CLOUD_FUNCTIONS.md) for details on implementing functions with secrets.

## Overview

The `/gen` endpoint accepts a prompt and returns generated text. It supports both Google's Gemini models and OpenAI's GPT models.

## Authentication

Requires any authenticated user (any role except `public`).

## Usage

### GET Request

```
GET /gen?prompt=Your+prompt+here&modelId=gemini-2.5-flash-lite
```

### POST Request

```typescript
const response = await fetch('/gen', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${idToken}`
  },
  body: JSON.stringify({
    prompt: 'Write a haiku about coding',
    modelId: 'gemini-2.5-flash-lite'
  })
})

const result = await response.json()
// { modelId: 'gemini-2.5-flash-lite', prompt: '...', text: '...' }
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | required | The prompt to send to the model |
| `modelId` | string | `'gemini-2.5-flash-lite'` | The model to use |

## Supported Models

### Gemini Models (prefix: `gemini-`)

- `gemini-2.5-flash-lite` (default)
- `gemini-2.0-flash`
- Other Gemini models as available

### OpenAI Models (prefix: `gpt-`)

- `gpt-4`
- `gpt-4-turbo`
- `gpt-3.5-turbo`
- Other GPT models as available

## Response

```json
{
  "modelId": "gemini-2.5-flash-lite",
  "prompt": "Write a haiku about coding",
  "text": "Lines of code unfold\nBugs hide in the syntax deep\nDebug, compile, run"
}
```

## Configuration

### Setting Up API Keys

The endpoint requires Firebase secrets for API keys:

```bash
# For Gemini
firebase functions:secrets:set gemini-api-key

# For ChatGPT
firebase functions:secrets:set chatgpt-api-key
```

### Getting API Keys

- **Gemini**: [Google AI Studio](https://makersuite.google.com/app/apikey)
- **OpenAI**: [OpenAI Platform](https://platform.openai.com/api-keys)

## Error Handling

| Status | Reason |
|--------|--------|
| 400 | Missing prompt or unrecognized model ID |
| 403 | User not authenticated or only has public role |
| 500 | Model API error |
| 503 | API key not configured (see setup instructions above) |

> **Note**: If you haven't configured the API secrets, the endpoint will return a 503 error with instructions on how to set up the required API key.

## Example: Client Integration

```typescript
// In your client code
async function generate(prompt: string, modelId?: string) {
  const token = await fb.getIdToken()
  
  const response = await fetch('/gen', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ prompt, modelId })
  })
  
  if (!response.ok) {
    throw new Error(await response.text())
  }
  
  return response.json()
}

// Usage
const result = await generate('Explain recursion in one sentence')
console.log(result.text)
```

## See Also

- [functions/src/gen.ts](../functions/src/gen.ts) - Endpoint implementation
- [CLOUD_FUNCTIONS.md](./CLOUD_FUNCTIONS.md) - Guide to implementing Cloud Functions with secrets
