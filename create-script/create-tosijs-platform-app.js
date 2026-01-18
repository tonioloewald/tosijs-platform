#!/usr/bin/env node

'use strict'

import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import readline from 'readline'

// Helper to prompt user
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

// Execute shell command
function exec(command, options = {}) {
  try {
    return execSync(command, {
      stdio: options.silent ? 'pipe' : 'inherit',
      encoding: 'utf-8',
      ...options,
    })
  } catch (error) {
    if (options.allowFailure) {
      return null
    }
    throw error
  }
}

// Execute and parse JSON output
function execJson(command) {
  try {
    const result = execSync(command, {
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    return JSON.parse(result)
  } catch {
    return null
  }
}

// Validation helpers
function validateProjectId(projectId) {
  const re = /^[a-z][a-z0-9-]*[a-z0-9]$/
  return re.test(projectId) && projectId.length >= 6 && projectId.length <= 30
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return re.test(email)
}

// Wait for user to press enter
async function waitForEnter(message = 'Press Enter when ready...') {
  await question(message)
}

// ============================================================================
// Step 1: Check prerequisites (Bun, Firebase CLI, logged in)
// ============================================================================

function checkBun() {
  try {
    const version = execSync('bun --version', {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim()
    console.log(`✓ Bun installed (${version})`)
    return true
  } catch {
    return false
  }
}

function checkFirebaseCLI() {
  try {
    const version = execSync('firebase --version', {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim()
    console.log(`✓ Firebase CLI installed (${version})`)
    return true
  } catch {
    return false
  }
}

function checkFirebaseLogin() {
  try {
    const result = execSync('firebase login:list', {
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    if (result.includes('No authorized accounts')) {
      return false
    }
    console.log('✓ Logged in to Firebase')
    return true
  } catch {
    return false
  }
}

async function ensurePrerequisites() {
  console.log('\n📋 Checking prerequisites...\n')

  if (!checkBun()) {
    console.log('\n❌ Bun is required but not installed.')
    console.log('\nInstall Bun:')
    console.log('  curl -fsSL https://bun.sh/install | bash\n')
    process.exit(1)
  }

  if (!checkFirebaseCLI()) {
    console.log('\n❌ Firebase CLI is required but not installed.')
    console.log('\nInstall Firebase CLI:')
    console.log('  bun install -g firebase-tools\n')
    process.exit(1)
  }

  if (!checkFirebaseLogin()) {
    console.log('\n❌ Not logged in to Firebase.')
    console.log('\nLogging you in now...\n')
    exec('firebase login')

    if (!checkFirebaseLogin()) {
      console.log('\n❌ Login failed. Please try again.\n')
      process.exit(1)
    }
  }
}

// ============================================================================
// Step 2 & 3: Get project ID and verify it exists
// ============================================================================

function getProjects() {
  const result = execJson('firebase projects:list --json')
  if (result?.status === 'success') {
    return result.result || []
  }
  return []
}

async function getProjectId(defaultId) {
  console.log('\n📋 Firebase Project Configuration\n')

  const projects = getProjects()

  if (projects.length > 0) {
    console.log('Your Firebase projects:')
    projects.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.projectId} (${p.displayName})`)
    })
    console.log()
  }

  const defaultValid = validateProjectId(defaultId)
  const prompt = defaultValid
    ? `Firebase Project ID [${defaultId}]: `
    : 'Firebase Project ID: '

  let projectId = await question(prompt)

  // Use default if they just hit enter
  if (!projectId && defaultValid) {
    projectId = defaultId
  }

  while (!validateProjectId(projectId)) {
    console.log(
      '❌ Invalid project ID. Use lowercase letters, numbers, and hyphens (6-30 chars).'
    )
    projectId = await question('Firebase Project ID: ')
  }

  // Check if project exists in user's account
  const project = projects.find((p) => p.projectId === projectId)

  if (!project) {
    console.log(
      `\n❌ Project "${projectId}" not found in your Firebase account.`
    )
    console.log('\nTo create a new project:')
    console.log('  1. Go to: https://console.firebase.google.com')
    console.log('  2. Click "Add project"')
    console.log(`  3. Name it "${projectId}"`)
    console.log('  4. Enable Google Analytics (optional)')
    console.log('  5. Upgrade to Blaze plan (required for Cloud Functions)')
    console.log('\nThen run this command again.\n')
    process.exit(1)
  }

  console.log(`✓ Found project: ${project.displayName}`)
  return projectId
}

// ============================================================================
// Step 4: Check Blaze plan
// ============================================================================

function checkBlazePlan(projectId) {
  // Try to list functions - this will fail with specific error if not on Blaze
  try {
    execSync(`firebase functions:list --project ${projectId}`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    return true
  } catch (error) {
    const msg = error.message || error.stderr || ''
    if (
      msg.includes('billing') ||
      msg.includes('Billing account') ||
      msg.includes('upgrade') ||
      msg.includes('pay-as-you-go') ||
      msg.includes('Cloud Functions')
    ) {
      return false
    }
    // Could be other errors (no functions deployed yet, etc.) - assume OK
    return true
  }
}

async function ensureBlazePlan(projectId) {
  console.log('\n🔍 Checking billing plan...')

  const hasBlaze = checkBlazePlan(projectId)

  if (!hasBlaze) {
    console.log('\n❌ Blaze plan required but not detected.')
    console.log(
      '\ntosijs-platform uses Cloud Functions, which require the Blaze (pay-as-you-go) plan.'
    )
    console.log('\n💡 Blaze includes generous FREE tier:')
    console.log('   • 2M function invocations/month')
    console.log('   • 5GB storage')
    console.log('   • 10GB hosting transfer')
    console.log('   Most small sites stay completely free!')
    console.log('\nTo upgrade:')
    console.log(
      `  1. Go to: https://console.firebase.google.com/project/${projectId}/usage/details`
    )
    console.log('  2. Click "Modify plan" → "Blaze"')
    console.log('  3. Add billing account')
    console.log('\nThen run this command again.\n')
    process.exit(1)
  }

  console.log('✓ Blaze plan active')
  return true
}

// ============================================================================
// Step 4b: Check Firestore Database exists
// ============================================================================

function checkFirestore(projectId) {
  try {
    // Try to access Firestore - will fail if not provisioned
    const result = execSync(
      `firebase firestore:indexes --project ${projectId}`,
      {
        stdio: 'pipe',
        encoding: 'utf-8',
      }
    )
    return true
  } catch (error) {
    const msg = error.message || error.stderr || ''
    if (
      msg.includes('NOT_FOUND') ||
      msg.includes('has not been used') ||
      msg.includes('FAILED_PRECONDITION') ||
      msg.includes('not been initialized')
    ) {
      return false
    }
    // Other errors might mean it exists but has other issues
    return true
  }
}

async function ensureFirestore(projectId) {
  console.log('\n🔍 Checking Firestore database...')

  const hasFirestore = checkFirestore(projectId)

  if (!hasFirestore) {
    console.log('\n❌ Firestore database not found.')
    console.log('\nPlease create a Firestore database:')
    console.log(
      `  1. Go to: https://console.firebase.google.com/project/${projectId}/firestore`
    )
    console.log('  2. Click "Create database"')
    console.log(
      '  3. Choose "Start in production mode" (our Functions handle security)'
    )
    console.log('  4. Select a location (us-central1 recommended)')
    await waitForEnter('\nPress Enter after creating the database...')

    // Re-check
    if (!checkFirestore(projectId)) {
      console.log(
        '\n❌ Firestore still not detected. Please check and try again.\n'
      )
      process.exit(1)
    }
  }

  console.log('✓ Firestore database exists')
  return true
}

// ============================================================================
// Step 4c: Check Cloud Storage exists
// ============================================================================

function checkStorage(projectId) {
  try {
    const result = execSync(`firebase storage:buckets --project ${projectId}`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    // If we get output with a bucket name, it exists
    return (
      result.includes('.appspot.com') || result.includes('.firebasestorage.app')
    )
  } catch {
    return false
  }
}

async function ensureStorage(projectId) {
  console.log('\n🔍 Checking Cloud Storage...')

  const hasStorage = checkStorage(projectId)

  if (!hasStorage) {
    console.log('\n❌ Cloud Storage not found.')
    console.log('\nPlease enable Cloud Storage:')
    console.log(
      `  1. Go to: https://console.firebase.google.com/project/${projectId}/storage`
    )
    console.log('  2. Click "Get started"')
    console.log("  3. Accept the default rules (we'll deploy our own)")
    await waitForEnter('\nPress Enter after enabling Storage...')

    // Re-check
    if (!checkStorage(projectId)) {
      console.log(
        '\n❌ Storage still not detected. Please check and try again.\n'
      )
      process.exit(1)
    }
  }

  console.log('✓ Cloud Storage enabled')
  return true
}

// ============================================================================
// Step 4d: Check/prompt for Google Authentication
// ============================================================================

async function ensureGoogleAuth(projectId) {
  console.log('\n🔍 Checking Authentication setup...')

  // We can't easily check if Google Auth is enabled via CLI,
  // so we prompt the user to verify
  console.log(
    '\n⚠️  Google Authentication must be enabled for sign-in to work.'
  )
  console.log('\nPlease verify Google sign-in is enabled:')
  console.log(
    `  1. Go to: https://console.firebase.google.com/project/${projectId}/authentication/providers`
  )
  console.log('  2. Click "Google" in the provider list')
  console.log('  3. Toggle "Enable" if not already enabled')
  console.log('  4. Set a project support email')
  console.log('  5. Click "Save"')
  await waitForEnter('\nPress Enter after enabling Google sign-in...')

  console.log('✓ Google Authentication configured (user confirmed)')
  return true
}

// ============================================================================
// Step 5: Check/create web app
// ============================================================================

function getWebApps(projectId) {
  const result = execJson(
    `firebase apps:list WEB --project ${projectId} --json`
  )
  if (result?.status === 'success') {
    return result.result || []
  }
  return []
}

function createWebApp(projectId, appName) {
  console.log(`\n📱 Creating web app "${appName}"...`)
  try {
    exec(`firebase apps:create WEB "${appName}" --project ${projectId}`, {
      silent: true,
    })
    console.log('✓ Web app created')
    return true
  } catch (error) {
    console.log('❌ Failed to create web app:', error.message)
    return false
  }
}

async function ensureWebApp(projectId, projectName) {
  console.log('\n🔍 Checking web apps...')

  const apps = getWebApps(projectId)

  // Look for an app with matching name - prefer projectId match, then projectName
  let app =
    apps.find((a) => a.displayName === projectId) ||
    apps.find((a) => a.displayName === projectName)

  // Default app name to use when creating - use projectId for consistency
  const defaultAppName = projectId

  if (!app && apps.length > 0) {
    console.log('\nExisting web apps:')
    apps.forEach((a, i) => {
      console.log(`  ${i + 1}. ${a.displayName}`)
    })

    const answer = await question(
      `\nUse existing app, or create new "${defaultAppName}"? [1-${apps.length}/new]: `
    )

    if (answer.toLowerCase() === 'new') {
      createWebApp(projectId, defaultAppName)
      // Refresh the list
      const newApps = getWebApps(projectId)
      app = newApps.find((a) => a.displayName === defaultAppName)
    } else {
      const index = parseInt(answer) - 1
      if (index >= 0 && index < apps.length) {
        app = apps[index]
      }
    }
  } else if (!app) {
    // No apps exist, create one
    createWebApp(projectId, defaultAppName)
    const newApps = getWebApps(projectId)
    app = newApps.find((a) => a.displayName === defaultAppName) || newApps[0]
  }

  if (!app) {
    console.log('\n❌ No web app available. Please create one manually:')
    console.log(
      `   https://console.firebase.google.com/project/${projectId}/settings/general`
    )
    process.exit(1)
  }

  console.log(`✓ Using web app: ${app.displayName}`)
  return app
}

// ============================================================================
// Step 6: Get SDK config
// ============================================================================

function getWebAppConfig(projectId, appId) {
  const result = execJson(
    `firebase apps:sdkconfig WEB ${appId} --project ${projectId} --json`
  )
  if (result?.status === 'success' && result.result?.sdkConfig) {
    return result.result.sdkConfig
  }
  return null
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\n🚀 Create tosijs-platform App\n')
  console.log('━'.repeat(50))

  // Check command line args
  if (process.argv.length < 3) {
    console.log('\nUsage: bunx create-tosijs-platform-app <project-name>')
    console.log('\nExample:')
    console.log('  bunx create-tosijs-platform-app my-awesome-site\n')
    process.exit(1)
  }

  const projectName = process.argv[2]
  const currentPath = process.cwd()
  const projectPath = path.join(currentPath, projectName)
  const gitRepo = 'https://github.com/tonioloewald/tosijs-platform.git'

  // Check if directory already exists
  if (fs.existsSync(projectPath)) {
    console.log(`\n❌ Directory "${projectName}" already exists.\n`)
    process.exit(1)
  }

  // Step 1: Prerequisites
  await ensurePrerequisites()

  // Step 2 & 3: Get and validate project ID
  const projectId = await getProjectId(projectName)

  // Step 4: Ensure Blaze plan
  await ensureBlazePlan(projectId)

  // Step 4b: Ensure Firestore exists
  await ensureFirestore(projectId)

  // Step 4c: Ensure Cloud Storage exists
  await ensureStorage(projectId)

  // Step 4d: Ensure Google Auth is enabled
  await ensureGoogleAuth(projectId)

  // Step 5: Ensure web app exists
  const webApp = await ensureWebApp(projectId, projectName)

  // Step 6: Get SDK config
  console.log('\n🔍 Fetching SDK configuration...')
  const sdkConfig = getWebAppConfig(projectId, webApp.appId)

  if (!sdkConfig) {
    console.log('❌ Failed to get SDK config')
    process.exit(1)
  }
  console.log('✓ Got SDK configuration')

  // Get admin email
  console.log()
  let adminEmail = await question(
    'Admin email (Google account for owner access): '
  )
  while (!validateEmail(adminEmail)) {
    console.log('❌ Invalid email address.')
    adminEmail = await question('Admin email: ')
  }

  // ============================================================================
  // Create project
  // ============================================================================

  console.log('\n📦 Creating project...\n')

  fs.mkdirSync(projectPath)

  console.log('📥 Cloning template...')
  exec(`git clone --depth 1 ${gitRepo} ${projectPath}`, { silent: true })

  process.chdir(projectPath)

  console.log('🧹 Cleaning up...')
  fs.rmSync(path.join(projectPath, '.git'), { recursive: true })
  if (fs.existsSync(path.join(projectPath, 'create-script'))) {
    fs.rmSync(path.join(projectPath, 'create-script'), { recursive: true })
  }

  // Configure firebase-config.ts with full SDK config
  console.log('⚙️  Configuring Firebase...')

  // Only include measurementId if it exists (Analytics enabled)
  const measurementLine = sdkConfig.measurementId
    ? `  measurementId: '${sdkConfig.measurementId}',\n`
    : ''

  const configContent = `// Auto-generated by create-tosijs-platform-app

const PROJECT_ID = '${sdkConfig.projectId}'

export const PRODUCTION_BASE = \`//us-central1-\${PROJECT_ID}.cloudfunctions.net/\`

export const config = {
  apiKey: '${sdkConfig.apiKey}',
  authDomain: '${sdkConfig.authDomain}',
  projectId: '${sdkConfig.projectId}',
  storageBucket: '${sdkConfig.storageBucket}',
  messagingSenderId: '${sdkConfig.messagingSenderId}',
  appId: '${sdkConfig.appId}',
${measurementLine}}
`
  fs.writeFileSync(
    path.join(projectPath, 'src/firebase-config.ts'),
    configContent
  )

  // Configure .firebaserc
  fs.writeFileSync(
    path.join(projectPath, '.firebaserc'),
    JSON.stringify({ projects: { default: projectId } }, null, 2)
  )

  // Update package.json - add setup script that runs from functions dir
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8')
  )
  packageJson.name = projectName
  packageJson.version = '0.1.0'
  packageJson.scripts.setup = 'cd functions && node setup.js'
  fs.writeFileSync(
    path.join(projectPath, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  )

  // Update initial_state role with admin email
  const roleFilePath = path.join(
    projectPath,
    'initial_state/firestore/role.json'
  )
  if (fs.existsSync(roleFilePath)) {
    const roles = JSON.parse(fs.readFileSync(roleFilePath, 'utf8'))
    const ownerRole = roles.find((r) => r._id === 'owner-role')
    if (ownerRole) {
      ownerRole.contacts = [{ type: 'email', value: adminEmail }]
    }
    fs.writeFileSync(roleFilePath, JSON.stringify(roles, null, 2))
  }

  // Clear test auth users
  const authUsersPath = path.join(projectPath, 'initial_state/auth/users.json')
  if (fs.existsSync(authUsersPath)) {
    fs.writeFileSync(authUsersPath, '[]')
  }

  // Update config.json
  const configJsonPath = path.join(
    projectPath,
    'initial_state/firestore/config.json'
  )
  if (fs.existsSync(configJsonPath)) {
    const configData = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'))
    const appConfig = configData.find((c) => c._id === 'app')
    if (appConfig) {
      appConfig.title = projectName
      appConfig.subtitle = `Welcome to ${projectName}`
      appConfig.description = `A tosijs-platform site`
      appConfig.host = `${projectId}.web.app`
    }
    fs.writeFileSync(configJsonPath, JSON.stringify(configData, null, 2))
  }

  // Generate index.html
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${projectName}</title>
    <meta name="description" content="A tosijs-platform site" />
    <meta property="og:title" content="${projectName}" />
    <meta property="og:description" content="A tosijs-platform site" />
    <meta property="og:image" content="/logo.png" />
    <link rel="icon" href="/favicon.ico" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#000000" />
    <link rel="apple-touch-icon" href="/logo.png" />
    <link rel="manifest" href="/manifest.json" />
    <script type="module" src="/index.js"></script>
  </head>
  <body></body>
</html>
`
  fs.writeFileSync(path.join(projectPath, 'public/index.html'), indexHtml)

  // Generate setup.js in functions directory where firebase-admin is available
  const setupScript = `#!/usr/bin/env node
// Setup script - run after deploying from project root: bun run setup
// Or from functions directory: node setup.js

import admin from 'firebase-admin'

const ADMIN_EMAIL = '${adminEmail}'
const PROJECT_ID = '${projectId}'

admin.initializeApp({ projectId: PROJECT_ID })
const db = admin.firestore()

async function setup() {
  console.log('\\nSetting up admin access...\\n')

  try {
    const user = await admin.auth().getUserByEmail(ADMIN_EMAIL)
    console.log(\`Found user: \${ADMIN_EMAIL} (uid: \${user.uid})\`)

    const rolesSnapshot = await db.collection('role')
      .where('contacts', 'array-contains', { type: 'email', value: ADMIN_EMAIL })
      .get()

    if (rolesSnapshot.empty) {
      console.log(\`No roles found for \${ADMIN_EMAIL}.\`)
      console.log('The database may not have been seeded yet.')
      console.log('Run: bun initial-deploy')
      process.exit(1)
    }

    for (const doc of rolesSnapshot.docs) {
      const data = doc.data()
      if (!data.userIds?.includes(user.uid)) {
        await doc.ref.update({
          userIds: admin.firestore.FieldValue.arrayUnion(user.uid)
        })
        console.log(\`Added to role: \${data.name}\`)
      } else {
        console.log(\`Already in role: \${data.name}\`)
      }
    }

    console.log('\\n✓ Setup complete!')
    console.log(\`\\nYou can now sign in at: https://${projectId}.web.app\`)

  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      console.log(\`User \${ADMIN_EMAIL} not found.\\n\`)
      console.log('Please:')
      console.log(\`  1. Visit https://${projectId}.web.app\`)
      console.log(\`  2. Sign in with \${ADMIN_EMAIL}\`)
      console.log('  3. Run this script again: bun run setup')
    } else {
      throw error
    }
  }
}

setup().catch(console.error)
`
  // Write setup.js to functions directory where firebase-admin is installed
  fs.writeFileSync(path.join(projectPath, 'functions/setup.js'), setupScript)

  console.log('📦 Installing dependencies...')
  exec('bun install', { silent: true })
  exec('cd functions && bun install', { silent: true })

  console.log('🔐 Generating TLS certificates...')
  const tlsScriptPath = path.join(projectPath, 'tls/create-dev-certs.sh')
  if (!fs.existsSync(tlsScriptPath)) {
    console.log(
      '⚠️  TLS certificate script not found. You may need to generate certificates manually.'
    )
    console.log('   See tls/README.txt for instructions.')
  } else {
    try {
      exec('cd tls && ./create-dev-certs.sh', { silent: true })
      // Verify certificates were created
      const certPath = path.join(projectPath, 'tls/certificate.pem')
      const keyPath = path.join(projectPath, 'tls/key.pem')
      if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        console.log(
          '⚠️  TLS certificates may not have been generated correctly.'
        )
        console.log(
          '   Run `cd tls && ./create-dev-certs.sh` manually if `bun start` fails.'
        )
      }
    } catch (error) {
      console.log(
        '⚠️  Failed to generate TLS certificates:',
        error.message || 'unknown error'
      )
      console.log(
        '   Run `cd tls && ./create-dev-certs.sh` manually before running `bun start`.'
      )
    }
  }

  // ============================================================================
  // Success output
  // ============================================================================

  console.log('\n' + '━'.repeat(50))
  console.log('\n✅ Project created successfully!\n')
  console.log('━'.repeat(50))
  console.log(`\n📁 Project: ${projectName}`)
  console.log(`🔥 Firebase: ${projectId}`)
  console.log(`👤 Admin: ${adminEmail}`)
  console.log('\n' + '━'.repeat(50))

  // Step 7: Offer initial deployment
  console.log('\n🚀 Ready to deploy!\n')

  const deploy = await question('Run initial deployment now? [Y/n]: ')

  if (deploy.toLowerCase() !== 'n') {
    console.log('\n📦 Running initial deployment...\n')
    console.log('This will:')
    console.log('  1. Build the client and functions')
    console.log('  2. Deploy to Firebase')
    console.log('  3. Seed the database\n')

    try {
      exec('bun run initial-deploy')

      console.log('\n' + '━'.repeat(50))
      console.log('\n✅ Deployment complete!\n')
      console.log('━'.repeat(50))
      console.log(`\nYour site is live at: https://${projectId}.web.app`)
      console.log('\nNext steps:')
      console.log(`  1. Visit your site and sign in with ${adminEmail}`)
      console.log('  2. Run: bun run setup')
      console.log('  3. Start developing: bun start')
    } catch {
      console.log('\n⚠️  Deployment had issues. You can run it manually:')
      console.log(`  cd ${projectName}`)
      console.log('  bun initial-deploy')
    }
  } else {
    console.log('\nTo deploy later:')
    console.log(`  cd ${projectName}`)
    console.log('  bun initial-deploy')
  }

  // Generate TODO.md
  const todoContent = `# ${projectName} Setup

## Project Info

- **Project:** ${projectName}
- **Firebase:** ${projectId}
- **Admin:** ${adminEmail}
- **URL:** https://${projectId}.web.app

## Commands

\`\`\`bash
bun start              # Local dev (production Firebase)
bun start-emulated     # Local dev (emulators)
bun deploy             # Deploy everything
bun deploy-functions   # Deploy functions only
bun deploy-hosting     # Deploy hosting only
\`\`\`

## Setup Checklist

- [ ] Deploy: \`bun initial-deploy\`
- [ ] Sign in at https://${projectId}.web.app
- [ ] Run: \`bun run setup\`

## Resources

- Documentation: https://github.com/tonioloewald/tosijs-platform
- tosijs: https://tosijs.net
- tosijs-ui: https://ui.tosijs.net
`
  fs.writeFileSync(path.join(projectPath, 'TODO.md'), todoContent)

  console.log('\n📝 Setup instructions saved to TODO.md')
  console.log('\n🎉 Happy building!\n')
}

main().catch((error) => {
  console.error('\n❌ Error:', error.message)
  process.exit(1)
})
