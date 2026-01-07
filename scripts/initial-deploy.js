#!/usr/bin/env bun

/**
 * Initial deployment script for tosijs-platform
 *
 * This script performs a complete first-time deployment:
 * 1. Builds the client
 * 2. Builds the functions
 * 3. Deploys everything to Firebase (functions, hosting, firestore rules, storage rules)
 * 4. Seeds the production database with initial data
 *
 * Usage:
 *   bun scripts/initial-deploy.js
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import readline from 'readline'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

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

function exec(command, options = {}) {
  console.log(`\n$ ${command}\n`)
  execSync(command, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  })
}

function question(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

async function main() {
  const PROJECT_ID = getProjectId()

  if (!PROJECT_ID) {
    console.error('Error: Could not read project ID from .firebaserc')
    process.exit(1)
  }

  console.log('━'.repeat(60))
  console.log('\n  tosijs-platform Initial Deployment\n')
  console.log('━'.repeat(60))
  console.log(`\nProject: ${PROJECT_ID}`)
  console.log('\nThis will:')
  console.log('  1. Build the client and functions')
  console.log('  2. Deploy everything to Firebase')
  console.log('  3. Seed the production database with initial data')

  const answer = await question('\nContinue? [y/N]: ')
  if (answer.toLowerCase() !== 'y') {
    console.log('Aborted.\n')
    process.exit(0)
  }

  console.log('\n' + '━'.repeat(60))
  console.log('\n  Step 1: Building client...\n')
  console.log('━'.repeat(60))
  exec('bun run build')

  console.log('\n' + '━'.repeat(60))
  console.log('\n  Step 2: Building functions...\n')
  console.log('━'.repeat(60))
  exec('bun run build', { cwd: path.join(projectRoot, 'functions') })

  console.log('\n' + '━'.repeat(60))
  console.log('\n  Step 3: Deploying to Firebase...\n')
  console.log('━'.repeat(60))
  exec('firebase deploy')

  console.log('\n' + '━'.repeat(60))
  console.log('\n  Step 4: Seeding production database...\n')
  console.log('━'.repeat(60))
  exec('bun scripts/seed-production.js')

  console.log('\n' + '━'.repeat(60))
  console.log('\n  Deployment complete!\n')
  console.log('━'.repeat(60))
  console.log(`\nYour site is live at: https://${PROJECT_ID}.web.app`)
  console.log('\nNext steps:')
  console.log('  1. Visit your site and sign in')
  console.log('  2. Run `node setup.js` to grant yourself owner access')
  console.log('  3. Start developing with `bun start`\n')
}

main().catch((error) => {
  console.error('\nDeployment failed:', error.message)
  process.exit(1)
})
