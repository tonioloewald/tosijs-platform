import { onRequest } from 'firebase-functions/v2/https'
import * as functions from 'firebase-functions'
import { defineSecret } from 'firebase-functions/params'
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'
import compression from 'compression'
import { optionsResponse, getUserRoles } from './utilities'
import { validate as schemaValidate } from 'tosijs-schema'

const geminiApiKey = defineSecret('gemini-api-key')
const chatgptApiKey = defineSecret('chatgpt-api-key')

const compressResponse = compression()

// Convert JSON Schema to Gemini's schema format
const toGeminiSchema = (jsonSchema: any): any => {
  if (!jsonSchema) return undefined

  const typeMap: Record<string, SchemaType> = {
    string: SchemaType.STRING,
    number: SchemaType.NUMBER,
    integer: SchemaType.INTEGER,
    boolean: SchemaType.BOOLEAN,
    array: SchemaType.ARRAY,
    object: SchemaType.OBJECT,
  }

  const convert = (schema: any): any => {
    if (!schema) return undefined

    const result: any = {}

    if (schema.type) {
      result.type = typeMap[schema.type] || SchemaType.STRING
    }

    if (schema.description) {
      result.description = schema.description
    }

    if (schema.enum) {
      result.enum = schema.enum
    }

    if (schema.properties) {
      result.properties = {}
      for (const [key, value] of Object.entries(schema.properties)) {
        result.properties[key] = convert(value)
      }
    }

    if (schema.required) {
      result.required = schema.required
    }

    if (schema.items) {
      result.items = convert(schema.items)
    }

    return result
  }

  return convert(jsonSchema)
}

const geminiCompletion = async (
  apiKey: string,
  model: string,
  content: string,
  schema?: any
): Promise<string | object> => {
  try {
    const genAI = new GoogleGenerativeAI(apiKey)

    if (schema) {
      // Structured output with schema
      const gemini = genAI.getGenerativeModel({
        model,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(schema),
        },
      })
      const result = await gemini.generateContent([content])
      const text = result.response.text()
      return JSON.parse(text)
    } else {
      // Regular text output
      const gemini = genAI.getGenerativeModel({ model })
      const result = await gemini.generateContent([content])
      return result.response.text()
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new Error(`Gemini generation failed: ${message}`)
  }
}

const chatgptCompletion = async (
  apiKey: string,
  model: string,
  content: string,
  schema?: any
): Promise<string | object> => {
  const url = 'https://api.openai.com/v1/chat/completions'

  const body: any = {
    model,
    messages: [
      {
        role: 'user',
        content,
      },
    ],
  }

  // Add structured output if schema provided
  if (schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        strict: true,
        schema,
      },
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Error: ${response.status} - ${response.statusText}`)
  }

  const result = await response.json()
  const text = result.choices[0].message.content

  if (schema) {
    return JSON.parse(text)
  }
  return text
}

interface GenParams {
  modelId?: string
  prompt: string
  schema?: any // JSON Schema for structured output
}

export const gen = onRequest(
  { secrets: [geminiApiKey, chatgptApiKey] },
  async (req, res) => {
    if (optionsResponse(req, res, ['GET', 'POST'])) {
      return
    }

    const userRoles = await getUserRoles(req)

    if (userRoles.roles.filter((role) => role !== 'public').length === 0) {
      res.status(403).send('forbidden')
      return
    }

    const { query, body } = req
    const source: GenParams = req.method === 'GET' ? query : body
    const { modelId, prompt, schema } = Object.assign(
      { modelId: 'gemini-2.5-flash-lite' },
      source
    )

    if (!prompt) {
      res.status(400).send('prompt required!')
      return
    }

    try {
      let result: string | object

      if (modelId.startsWith('gemini-')) {
        const apiKey = geminiApiKey.value()
        if (!apiKey) {
          res
            .status(503)
            .send(
              'Gemini API key not configured. Run: firebase functions:secrets:set gemini-api-key'
            )
          return
        }
        result = await geminiCompletion(apiKey, modelId, prompt, schema)
      } else if (modelId.startsWith('gpt-')) {
        const apiKey = chatgptApiKey.value()
        if (!apiKey) {
          res
            .status(503)
            .send(
              'ChatGPT API key not configured. Run: firebase functions:secrets:set chatgpt-api-key'
            )
          return
        }
        result = await chatgptCompletion(apiKey, modelId, prompt, schema)
      } else {
        res.status(400).send('unrecognized modelId')
        return
      }

      // If schema was provided, validate the response
      if (schema && typeof result === 'object') {
        const errors: Array<{ path: string; message: string }> = []
        const valid = schemaValidate(result, schema, (path, message) => {
          errors.push({ path, message })
        })

        compressResponse(req, res, () => {
          res.json({
            modelId,
            prompt,
            data: result,
            valid,
            ...(errors.length > 0 ? { errors } : {}),
          })
        })
      } else {
        // Text response (no schema)
        compressResponse(req, res, () => {
          res.json({
            modelId,
            prompt,
            text: result as string,
          })
        })
      }
    } catch (e) {
      functions.logger.error('Generation failed:', e)
      res.status(500).send('Generation failed')
    }
  }
)
