#!/usr/bin/env node

/**
 * Seed script for Firebase emulators
 *
 * This script imports initial_state data into running Firebase emulators.
 * Run this after starting emulators to populate them with seed data.
 *
 * Usage:
 *   node bin/seed-emulators.js
 *   node bin/seed-emulators.js --clear  # Clear existing data first
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const initialStatePath = path.join(projectRoot, 'initial_state')

// Emulator endpoints
const FIRESTORE_HOST = 'http://localhost:8080'
const AUTH_HOST = 'http://localhost:9099'
const STORAGE_HOST = 'http://localhost:9199'

// Get project ID from .firebaserc
function getProjectId() {
  try {
    const firebaserc = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.firebaserc'), 'utf-8')
    )
    return firebaserc.projects?.default || 'demo-project'
  } catch {
    return 'demo-project'
  }
}

const PROJECT_ID = getProjectId()

async function clearFirestore() {
  console.log('Clearing Firestore...')
  try {
    const response = await fetch(
      `${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
      { method: 'DELETE' }
    )
    if (response.ok) {
      console.log('  Firestore cleared')
    } else {
      console.log('  Warning: Could not clear Firestore')
    }
  } catch (error) {
    console.log('  Warning: Firestore emulator not reachable')
  }
}

async function clearAuth() {
  console.log('Clearing Auth...')
  try {
    const response = await fetch(
      `${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/accounts`,
      { method: 'DELETE' }
    )
    if (response.ok) {
      console.log('  Auth cleared')
    } else {
      console.log('  Warning: Could not clear Auth')
    }
  } catch (error) {
    console.log('  Warning: Auth emulator not reachable')
  }
}

async function seedAuth() {
  console.log('Seeding Auth...')
  const authPath = path.join(initialStatePath, 'auth')
  const usersFile = path.join(authPath, 'users.json')

  if (!fs.existsSync(usersFile)) {
    console.log('  No auth seed data found')
    return
  }

  try {
    const users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'))

    if (!Array.isArray(users)) {
      console.log('  users.json is not an array')
      return
    }

    let count = 0
    for (const user of users) {
      const isGoogle = user.provider === 'google'
      let response

      if (isGoogle) {
        // Create Google OAuth user via signInWithIdp
        // The emulator accepts fake ID tokens in a specific format
        const fakeIdToken = JSON.stringify({
          sub: user.uid,
          email: user.email,
          name: user.displayName,
          email_verified: true,
        })
        const postBody = `id_token=${encodeURIComponent(
          fakeIdToken
        )}&providerId=google.com`

        response = await fetch(
          `${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer owner',
            },
            body: JSON.stringify({
              postBody,
              requestUri: 'http://localhost',
              returnSecureToken: true,
              returnIdpCredential: true,
            }),
          }
        )
      } else {
        // Create password user via signUp
        response = await fetch(
          `${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer owner',
            },
            body: JSON.stringify({
              localId: user.uid,
              email: user.email,
              password: 'password123',
              displayName: user.displayName,
            }),
          }
        )
      }

      if (response.ok) {
        count++
      } else {
        const error = await response.text()
        // Ignore "already exists" errors
        if (
          error.includes('EMAIL_EXISTS') ||
          error.includes('DUPLICATE_LOCAL_ID')
        ) {
          count++
        } else {
          console.log(`  Error creating user ${user.email}: ${error}`)
        }
      }
    }

    console.log(`  ${count} users`)
  } catch (error) {
    console.log(`  Error seeding auth: ${error.message}`)
  }
}

async function seedFirestore() {
  console.log('Seeding Firestore...')
  const firestorePath = path.join(initialStatePath, 'firestore')

  if (!fs.existsSync(firestorePath)) {
    console.log('  No firestore seed data found')
    return
  }

  const files = fs.readdirSync(firestorePath).filter((f) => f.endsWith('.json'))

  for (const file of files) {
    // Convert filename to collection path (| -> /)
    const collectionPath = file.replace(/\.json$/, '').replace(/\|/g, '/')
    const filePath = path.join(firestorePath, file)

    try {
      const documents = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

      if (!Array.isArray(documents)) {
        console.log(`  Skipping ${file}: not an array`)
        continue
      }

      let count = 0
      for (const doc of documents) {
        const docId = doc._id
        if (!docId) {
          console.log(`  Skipping document without _id in ${file}`)
          continue
        }

        // Remove _id from data (it's the document ID, not a field)
        const data = { ...doc }
        delete data._id

        // Add metadata fields
        const now = new Date().toISOString()
        data._created = data._created || now
        data._modified = data._modified || now
        data._path = `${collectionPath}/${docId}`

        // Note: userIds are auto-populated by the cloud function on first login
        // based on email matching in contacts

        // Write to Firestore emulator using REST API
        const url = `${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collectionPath}/${docId}`

        const firestoreDoc = {
          fields: objectToFirestoreFields(data),
        }

        const response = await fetch(url, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer owner', // Bypass security rules in emulator
          },
          body: JSON.stringify(firestoreDoc),
        })

        if (response.ok) {
          count++
        } else {
          const error = await response.text()
          console.log(`  Error writing ${collectionPath}/${docId}: ${error}`)
        }
      }

      console.log(`  ${collectionPath}: ${count} documents`)
    } catch (error) {
      console.log(`  Error processing ${file}: ${error.message}`)
    }
  }
}

function objectToFirestoreFields(obj) {
  const fields = {}
  for (const [key, value] of Object.entries(obj)) {
    fields[key] = valueToFirestoreValue(value)
  }
  return fields
}

function valueToFirestoreValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null }
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value }
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { integerValue: String(value) }
    }
    return { doubleValue: value }
  }
  if (typeof value === 'string') {
    return { stringValue: value }
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(valueToFirestoreValue),
      },
    }
  }
  if (typeof value === 'object') {
    return {
      mapValue: {
        fields: objectToFirestoreFields(value),
      },
    }
  }
  return { stringValue: String(value) }
}

async function seedStorage() {
  console.log('Seeding Storage...')
  const storagePath = path.join(initialStatePath, 'storage')

  if (!fs.existsSync(storagePath)) {
    console.log('  No storage seed data found')
    return
  }

  // Walk the storage directory and upload files
  const uploadFile = async (localPath, remotePath) => {
    const content = fs.readFileSync(localPath)
    let contentType = getContentType(localPath)

    // Firebase Storage emulator has a bug where it tries to parse application/json
    // content with body-parser, causing uploads to hang or fail. Use octet-stream instead.
    if (contentType === 'application/json') {
      contentType = 'application/octet-stream'
    }

    // Firebase Storage emulator upload endpoint (Google Cloud Storage JSON API format)
    const url = `${STORAGE_HOST}/upload/storage/v1/b/${PROJECT_ID}.appspot.com/o?uploadType=media&name=${encodeURIComponent(
      remotePath
    )}`

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000) // 10s timeout

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
        },
        body: content,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const error = await response.text()
        console.log(
          `  Error uploading ${remotePath}: ${response.status} ${error}`
        )
      }
      return response.ok
    } catch (error) {
      console.log(`  Error uploading ${remotePath}: ${error.message}`)
      return false
    }
  }

  const walkDir = async (dir, prefix = '') => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    let count = 0

    for (const entry of entries) {
      const localPath = path.join(dir, entry.name)
      const remotePath = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        count += await walkDir(localPath, remotePath)
      } else if (entry.isFile() && !entry.name.startsWith('.')) {
        console.log(`  Uploading ${remotePath}...`)
        if (await uploadFile(localPath, remotePath)) {
          count++
        }
      }
    }

    return count
  }

  const count = await walkDir(storagePath)
  console.log(`  ${count} files`)
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const types = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
  }
  return types[ext] || 'application/octet-stream'
}

async function main() {
  const args = process.argv.slice(2)
  const shouldClear = args.includes('--clear')

  console.log(`\nSeeding emulators for project: ${PROJECT_ID}\n`)

  // Check if emulators are running
  try {
    await fetch(`${FIRESTORE_HOST}/`)
  } catch {
    console.log('Error: Firestore emulator is not running.')
    console.log('Start emulators first: bun run start-emulated\n')
    process.exit(1)
  }

  if (shouldClear) {
    await clearFirestore()
    await clearAuth()
    console.log('')
  }

  // Seed auth first to build email -> uid mapping
  await seedAuth()
  // Then seed firestore (roles will get userIds populated from contacts)
  await seedFirestore()
  await seedStorage()

  console.log('\nSeeding complete!\n')
}

main().catch((error) => {
  console.error('Error:', error.message)
  process.exit(1)
})
