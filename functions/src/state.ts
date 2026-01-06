/**
 * Admin utility routes for pushing and pulling state
 *
 * These routes allow owners to:
 * - Push seed data from initial_state to Firestore
 * - Pull current Firestore state to a JSON format
 *
 * Only accessible to users with the 'owner' role.
 */

import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import { optionsResponse, getUserRoles } from './utilities'
import { ROLES } from './collections/roles'

const db = admin.firestore()

interface StateDocument {
  _id: string
  [key: string]: any
}

interface CollectionState {
  [collectionName: string]: StateDocument[]
}

/**
 * Pull state from Firestore collections
 *
 * GET /state/pull?collections=page,post,role,module
 *
 * Returns JSON with all documents from specified collections
 */
async function pullState(req: any, res: any): Promise<void> {
  const collectionsParam = req.query.collections || 'page,post,role,module'
  const collections = collectionsParam.split(',').map((c: string) => c.trim())

  const state: CollectionState = {}

  for (const collectionName of collections) {
    try {
      const snapshot = await db.collection(collectionName).get()
      const documents: StateDocument[] = []

      snapshot.forEach((doc) => {
        const data = doc.data()
        // Skip deleted documents
        if (data._deleted) return

        // Remove internal fields that shouldn't be in seed data
        const cleanData: StateDocument = { _id: doc.id }
        for (const [key, value] of Object.entries(data)) {
          // Keep _id but skip other underscore-prefixed metadata
          if (!key.startsWith('_')) {
            cleanData[key] = value
          }
        }
        documents.push(cleanData)
      })

      state[collectionName] = documents
    } catch (error: any) {
      functions.logger.error(
        `Error pulling collection ${collectionName}:`,
        error
      )
      state[collectionName] = []
    }
  }

  res.status(200).json(state)
}

/**
 * Push state to Firestore collections
 *
 * POST /state/push
 * Body: { "page": [...], "post": [...], ... }
 *
 * Writes documents to Firestore (upserts by _id)
 */
async function pushState(req: any, res: any): Promise<void> {
  const state: CollectionState = req.body

  if (!state || typeof state !== 'object') {
    res.status(400).json({
      error: 'Request body must be a JSON object with collection arrays',
    })
    return
  }

  const results: { [key: string]: { success: number; errors: number } } = {}

  for (const [collectionName, documents] of Object.entries(state)) {
    if (!Array.isArray(documents)) {
      results[collectionName] = { success: 0, errors: 1 }
      continue
    }

    let success = 0
    let errors = 0

    for (const doc of documents) {
      const { _id: docId, ...data } = doc
      if (!docId) {
        errors++
        continue
      }

      try {
        // Add metadata
        const now = new Date().toISOString()
        const record: Record<string, any> = {
          ...data,
          _created: data._created || now,
          _modified: now,
          _path: `${collectionName}/${docId}`,
        }

        await db
          .collection(collectionName)
          .doc(docId)
          .set(record, { merge: true })
        success++
      } catch (error: any) {
        functions.logger.error(
          `Error writing ${collectionName}/${docId}:`,
          error
        )
        errors++
      }
    }

    results[collectionName] = { success, errors }
  }

  res.status(200).json({ results })
}

/**
 * Clear all documents from specified collections
 *
 * POST /state/clear?collections=page,post
 *
 * Deletes all documents from the specified collections.
 * Use with caution!
 */
async function clearState(req: any, res: any): Promise<void> {
  const collectionsParam = req.query.collections

  if (!collectionsParam) {
    res.status(400).json({ error: 'collections query parameter is required' })
    return
  }

  const collections = collectionsParam.split(',').map((c: string) => c.trim())
  const results: { [key: string]: number } = {}

  for (const collectionName of collections) {
    try {
      const snapshot = await db.collection(collectionName).get()
      const batch = db.batch()
      let count = 0

      snapshot.forEach((doc) => {
        batch.delete(doc.ref)
        count++
      })

      await batch.commit()
      results[collectionName] = count
    } catch (error: any) {
      functions.logger.error(
        `Error clearing collection ${collectionName}:`,
        error
      )
      results[collectionName] = -1
    }
  }

  res.status(200).json({ cleared: results })
}

export const state = functions.https.onRequest(async (req, res) => {
  if (optionsResponse(req, res, ['GET', 'POST'])) {
    return
  }

  // Check authorization - owner role required
  const userRoles = await getUserRoles(req)
  if (!userRoles.roles.includes(ROLES.owner)) {
    res.status(403).json({ error: 'Owner role required' })
    return
  }

  // Route based on path
  const pathParts = req.path.split('/').filter(Boolean)
  const action = pathParts[0] || ''

  try {
    switch (action) {
      case 'pull':
        await pullState(req, res)
        break
      case 'push':
        await pushState(req, res)
        break
      case 'clear':
        await clearState(req, res)
        break
      default:
        res.status(400).json({
          error: 'Unknown action',
          usage: {
            pull: 'GET /state/pull?collections=page,post,role,module',
            push: 'POST /state/push with JSON body { "collection": [...documents] }',
            clear:
              'POST /state/clear?collections=page,post (use with caution!)',
          },
        })
    }
  } catch (error: unknown) {
    functions.logger.error('State operation error:', error)
    res.status(500).json({ error: 'Operation failed' })
  }
})
