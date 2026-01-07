#!/usr/bin/env bun

/**
 * Seed script for production Firebase
 *
 * This script imports initial_state/firestore data into your production Firestore.
 * It checks for existing data and refuses to seed if the database appears to be
 * already initialized (to prevent accidental data loss).
 *
 * Usage:
 *   bun scripts/seed-production.js
 *   bun scripts/seed-production.js --force  # Skip safety checks (dangerous!)
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const initialStatePath = path.join(projectRoot, 'initial_state')

// Get project ID from .firebaserc
function getProjectId() {
  try {
    const firebaserc = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.firebaserc'), 'utf-8')
    )
    return firebaserc.projects?.default
  } catch {
    return null
  }
}

const PROJECT_ID = getProjectId()

if (!PROJECT_ID) {
  console.error('Error: Could not read project ID from .firebaserc')
  process.exit(1)
}

// Initialize Firebase Admin (uses application default credentials)
initializeApp({ projectId: PROJECT_ID })
const db = getFirestore()

async function checkExistingData() {
  // Check if config/app document exists (sign of previous seeding)
  const configDoc = await db.collection('config').doc('app').get()
  if (configDoc.exists) {
    return { exists: true, reason: 'config/app document exists' }
  }

  // Check if any roles exist
  const rolesSnapshot = await db.collection('role').limit(1).get()
  if (!rolesSnapshot.empty) {
    return { exists: true, reason: 'role collection has documents' }
  }

  // Check if any posts exist
  const postsSnapshot = await db.collection('post').limit(1).get()
  if (!postsSnapshot.empty) {
    return { exists: true, reason: 'post collection has documents' }
  }

  return { exists: false }
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

        await db.collection(collectionPath).doc(docId).set(data)
        count++
      }

      console.log(`  ${collectionPath}: ${count} documents`)
    } catch (error) {
      console.log(`  Error processing ${file}: ${error.message}`)
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const forceMode = args.includes('--force')

  console.log(`\nSeeding production Firestore for project: ${PROJECT_ID}\n`)

  if (!forceMode) {
    console.log('Checking for existing data...')
    const check = await checkExistingData()

    if (check.exists) {
      console.log(`\nError: Database appears to be already initialized.`)
      console.log(`Reason: ${check.reason}`)
      console.log(`\nIf you really want to seed anyway, use: bun scripts/seed-production.js --force`)
      console.log(`Warning: --force will overwrite existing documents!\n`)
      process.exit(1)
    }

    console.log('  No existing data found, safe to proceed.\n')
  } else {
    console.log('Warning: --force mode enabled, skipping safety checks!\n')
  }

  await seedFirestore()

  console.log('\nProduction seeding complete!\n')
}

main().catch((error) => {
  console.error('Error:', error.message)
  process.exit(1)
})
