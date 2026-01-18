#!/usr/bin/env bun

/**
 * Initial deployment script for tosijs-platform
 *
 * This script performs a complete first-time deployment:
 * 1. Builds the client
 * 2. Builds the functions
 * 3. Deploys everything to Firebase (functions, hosting, firestore rules, storage rules)
 * 4. Seeds the production database with initial data
 * 5. Verifies the deployment
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

function execSilent(command, options = {}) {
  try {
    return execSync(command, {
      cwd: projectRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
      ...options,
    })
  } catch {
    return null
  }
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

async function verifyDeployment(projectId) {
  console.log('\n🔍 Verifying deployment...\n')

  const issues = []

  // Check if functions are deployed
  const functionsResult = execSilent(
    `firebase functions:list --project ${projectId}`
  )
  if (!functionsResult || functionsResult.includes('No functions')) {
    issues.push('Cloud Functions may not have deployed correctly')
  } else {
    console.log('✓ Cloud Functions deployed')
  }

  // Check if hosting is accessible
  const siteUrl = `https://${projectId}.web.app`
  try {
    const response = await fetch(siteUrl, { method: 'HEAD' })
    if (response.ok) {
      console.log('✓ Hosting is live')
    } else {
      issues.push(`Hosting returned status ${response.status}`)
    }
  } catch (error) {
    issues.push(`Could not reach ${siteUrl}: ${error.message}`)
  }

  // Check if a key function endpoint is responding
  const helloUrl = `https://us-central1-${projectId}.cloudfunctions.net/hello`
  try {
    const response = await fetch(helloUrl)
    if (response.ok) {
      console.log('✓ Functions endpoint responding')
    } else {
      issues.push(`Functions endpoint returned status ${response.status}`)
    }
  } catch (error) {
    // Functions may take a moment to become available after deploy
    console.log('⚠️  Functions endpoint not yet responding (may take a minute)')
  }

  return issues
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
  console.log('  4. Verify the deployment')

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
  console.log('\n  Step 5: Verifying deployment...\n')
  console.log('━'.repeat(60))
  const issues = await verifyDeployment(PROJECT_ID)

  console.log('\n' + '━'.repeat(60))
  if (issues.length === 0) {
    console.log('\n✅ Deployment complete and verified!\n')
  } else {
    console.log('\n⚠️  Deployment complete with warnings:\n')
    issues.forEach((issue) => console.log(`   • ${issue}`))
    console.log('\nThese may resolve themselves in a few minutes.')
  }
  console.log('━'.repeat(60))
  console.log(`\nYour site is live at: https://${PROJECT_ID}.web.app`)
  console.log('\nNext steps:')
  console.log('  1. Visit your site and sign in')
  console.log('  2. Run `bun run setup` to grant yourself owner access')
  console.log('  3. Start developing with `bun start`\n')
}

main().catch((error) => {
  console.error('\nDeployment failed:', error.message)
  process.exit(1)
})
