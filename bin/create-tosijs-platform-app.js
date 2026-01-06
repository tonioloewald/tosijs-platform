#! /usr/bin/env node

'use strict'

import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import readline from 'readline'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function question(query) {
  return new Promise((resolve) => rl.question(query, resolve))
}

function execCommand(command, options = {}) {
  try {
    return execSync(command, {
      stdio: options.silent ? 'pipe' : 'inherit',
      encoding: 'utf-8',
      ...options,
    })
  } catch (error) {
    if (!options.allowFailure) {
      throw error
    }
    return null
  }
}

function checkBun() {
  try {
    const version = execSync('bun --version', {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim()
    console.log(`✓ Bun installed (${version})`)
    return true
  } catch (error) {
    console.log('✗ Bun not found')
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
  } catch (error) {
    console.log('✗ Firebase CLI not found')
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
    console.log('✓ Firebase CLI is logged in')
    return true
  } catch (error) {
    return false
  }
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return re.test(email)
}

function validateProjectId(projectId) {
  const re = /^[a-z0-9-]+$/
  return re.test(projectId) && projectId.length >= 6 && projectId.length <= 30
}

function getFirebaseConfig(projectId) {
  try {
    console.log('\n🔍 Fetching Firebase configuration...')
    const appsJson = execSync(
      `firebase apps:sdkconfig web --project ${projectId}`,
      {
        stdio: 'pipe',
        encoding: 'utf-8',
      }
    )

    const config = JSON.parse(appsJson)
    if (config && config.projectId) {
      console.log('✓ Successfully retrieved Firebase config')
      return config
    }
    return null
  } catch (error) {
    console.log('⚠ Could not auto-fetch Firebase config')
    if (error.message.includes('No apps found')) {
      console.log('  You need to create a Web App in Firebase Console first.')
    }
    return null
  }
}

function checkFirestoreExists(projectId) {
  try {
    execSync(`firebase firestore:databases:list --project ${projectId}`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    return true
  } catch (error) {
    return false
  }
}

function checkBlazePlan(projectId) {
  try {
    // Try to get project info - Blaze plan info is in the project details
    const projectInfo = execSync(`firebase projects:list --json`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    })

    const projects = JSON.parse(projectInfo)
    const project = projects.find((p) => p.projectId === projectId)

    // If we can't determine, return null (unknown)
    // The billing plan isn't directly in projects:list, so we'll try another approach

    // Try to list functions - this will fail if not on Blaze plan
    execSync(`firebase functions:list --project ${projectId}`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    })

    // If the command succeeds, they likely have functions enabled (Blaze plan)
    return true
  } catch (error) {
    // If error mentions billing or quota, definitely not on Blaze
    if (
      error.message.includes('billing') ||
      error.message.includes('quota') ||
      error.message.includes('upgrade') ||
      error.message.includes('requires a paid plan')
    ) {
      return false
    }
    // Otherwise, we can't determine - return null
    return null
  }
}

async function main() {
  console.log('\n🚀 Create tosijs-platform App\n')

  if (process.argv.length < 3) {
    console.log('Usage: npx create-tosijs-platform-app <project-name>')
    console.log('Example: npx create-tosijs-platform-app my-awesome-site\n')
    process.exit(1)
  }

  const projectName = process.argv[2]
  const currentPath = process.cwd()
  const projectPath = path.join(currentPath, projectName)
  const gitRepo = 'https://github.com/tonioloewald/tosijs-platform.git'

  console.log('Checking prerequisites...\n')

  const hasBun = checkBun()
  if (!hasBun) {
    console.log('\n❌ Bun is required but not installed.')
    console.log('\nTo install Bun, run:')
    console.log('  curl -fsSL https://bun.sh/install | bash\n')
    console.log('Then run this command again.\n')
    process.exit(1)
  }

  const hasFirebase = checkFirebaseCLI()
  if (!hasFirebase) {
    console.log('\n❌ Firebase CLI is required but not installed.')
    console.log('\nTo install Firebase CLI, run:')
    console.log('  bun install -g firebase-tools\n')
    console.log('Then run this command again.\n')
    process.exit(1)
  }

  const isLoggedIn = checkFirebaseLogin()
  if (!isLoggedIn) {
    console.log('\n❌ You need to be logged in to Firebase.')
    console.log('\nRun this command to log in:')
    console.log('  firebase login\n')
    console.log('Then run this command again.\n')
    process.exit(1)
  }

  console.log('\n📋 Project Configuration\n')
  console.log('Required information:\n')

  let firebaseProjectId = await question('Firebase Project ID: ')
  while (!validateProjectId(firebaseProjectId)) {
    console.log(
      '❌ Invalid project ID. Use lowercase letters, numbers, and hyphens only (6-30 characters).'
    )
    firebaseProjectId = await question('Firebase Project ID: ')
  }

  let adminEmail = await question('Admin Email (Google account): ')
  while (!validateEmail(adminEmail)) {
    console.log('❌ Invalid email address.')
    adminEmail = await question('Admin Email (Google account): ')
  }

  rl.close()

  const firestoreExists = checkFirestoreExists(firebaseProjectId)
  if (firestoreExists) {
    console.log(
      '\n⚠️  Warning: Firestore database already exists in this project.'
    )
    console.log('This tool will NOT modify your existing data.\n')
  }

  const hasBlazePlan = checkBlazePlan(firebaseProjectId)
  if (hasBlazePlan === false) {
    console.log('\n🚨 CRITICAL: Blaze Plan Required\n')
    console.log('━'.repeat(60))
    console.log(
      '\ntosijs-platform uses Cloud Functions for secure data access.'
    )
    console.log(
      'Cloud Functions require the Firebase Blaze (pay-as-you-go) plan.\n'
    )
    console.log('⚠️  Your project is currently on the FREE (Spark) plan.')
    console.log('\n❌ The platform will NOT work without upgrading.\n')
    console.log('To upgrade to Blaze plan:')
    console.log(
      `1. Visit: https://console.firebase.google.com/project/${firebaseProjectId}/usage/details`
    )
    console.log('2. Click "Modify plan"')
    console.log('3. Select "Blaze - Pay as you go"')
    console.log('4. Add a billing account\n')
    console.log('💡 Blaze plan includes generous free tier:')
    console.log('   • 2M function invocations/month FREE')
    console.log('   • 5GB storage FREE')
    console.log('   • Most small sites stay within free limits\n')
    console.log('━'.repeat(60))

    const answer = await new Promise((resolve) => {
      const newRl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      newRl.question(
        '\nContinue anyway? (you must upgrade before deploying) [y/N]: ',
        (ans) => {
          newRl.close()
          resolve(ans)
        }
      )
    })

    if (!answer || answer.toLowerCase() !== 'y') {
      console.log(
        '\nSetup cancelled. Please upgrade to Blaze plan and try again.\n'
      )
      process.exit(0)
    }

    console.log(
      '\n⚠️  Remember: You MUST upgrade to Blaze plan before deploying!\n'
    )
  } else if (hasBlazePlan === true) {
    console.log('✓ Blaze plan detected - Cloud Functions enabled')
  } else {
    console.log('⚠️  Could not verify billing plan (you may need Blaze plan)')
  }

  const firebaseConfig = getFirebaseConfig(firebaseProjectId)

  if (!firebaseConfig) {
    console.log('\n⚠️  Could not automatically fetch Firebase config.')
    console.log('\nYou will need to manually configure src/firebase-config.ts')
    console.log('Get your config from:')
    console.log(
      `https://console.firebase.google.com/project/${firebaseProjectId}/settings/general\n`
    )
  }

  console.log('\n📦 Creating project...\n')

  try {
    fs.mkdirSync(projectPath)
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.log(`❌ Directory "${projectName}" already exists.\n`)
    } else {
      console.log(`❌ Error creating directory: ${err.message}\n`)
    }
    process.exit(1)
  }

  console.log('📥 Downloading template...')
  execCommand(`git clone --depth 1 ${gitRepo} ${projectPath}`)

  process.chdir(projectPath)

  console.log('🧹 Cleaning up...')
  fs.rmSync(path.join(projectPath, '.git'), { recursive: true })
  if (fs.existsSync(path.join(projectPath, 'bin'))) {
    fs.rmSync(path.join(projectPath, 'bin'), { recursive: true })
  }

  // Configure initial_state: update owner role with admin email
  // (keeps other test roles for emulator development)
  console.log('📝 Configuring initial state...')
  const roleFilePath = path.join(
    projectPath,
    'initial_state/firestore/role.json'
  )
  if (fs.existsSync(roleFilePath)) {
    const roles = JSON.parse(fs.readFileSync(roleFilePath, 'utf8'))
    const ownerRole = roles.find((r) => r._id === 'owner-role')
    if (ownerRole) {
      // Update the owner role's email contact
      ownerRole.contacts = [{ type: 'email', value: adminEmail }]
    }
    fs.writeFileSync(roleFilePath, JSON.stringify(roles, null, 2))
  }

  // Remove test auth users (only used for emulator development)
  const authUsersPath = path.join(projectPath, 'initial_state/auth/users.json')
  if (fs.existsSync(authUsersPath)) {
    fs.writeFileSync(authUsersPath, '[]')
  }

  console.log('⚙️  Configuring project...')

  let configContent
  if (firebaseConfig) {
    configContent = `const PROJECT_ID = '${firebaseProjectId}'

export const PRODUCTION_BASE = \`//us-central1-\${PROJECT_ID}.cloudfunctions.net/\`

export const config = {
  authDomain: '${firebaseConfig.authDomain}',
  projectId: '${firebaseConfig.projectId}',
  storageBucket: '${firebaseConfig.storageBucket}',
  apiKey: '${firebaseConfig.apiKey}',
  messagingSenderId: '${firebaseConfig.messagingSenderId}',
  appId: '${firebaseConfig.appId}',
  measurementId: '${firebaseConfig.measurementId || 'G-XXXXXXXXXX'}',
}
`
  } else {
    configContent = `const PROJECT_ID = '${firebaseProjectId}'

export const PRODUCTION_BASE = \`//us-central1-\${PROJECT_ID}.cloudfunctions.net/\`

export const config = {
  authDomain: \`\${PROJECT_ID}.firebaseapp.com\`,
  projectId: PROJECT_ID,
  storageBucket: \`\${PROJECT_ID}.appspot.com\`,
  apiKey: 'YOUR_API_KEY_HERE',
  messagingSenderId: 'YOUR_SENDER_ID_HERE',
  appId: 'YOUR_APP_ID_HERE',
  measurementId: 'YOUR_MEASUREMENT_ID_HERE',
}
`
  }

  fs.writeFileSync(
    path.join(projectPath, 'src/firebase-config.ts'),
    configContent
  )

  // Update config.json with project-specific values
  const configJsonPath = path.join(
    projectPath,
    'initial_state/firestore/config.json'
  )
  const configData = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'))

  // Update app config
  const appConfig = configData.find((c) => c._id === 'app')
  if (appConfig) {
    appConfig.title = projectName
    appConfig.subtitle = `Welcome to ${projectName}`
    appConfig.description = `A tosijs-platform site`
    appConfig.host = `${firebaseProjectId}.web.app`
  }

  // Update blog config
  const blogConfig = configData.find((c) => c._id === 'blog')
  if (blogConfig) {
    blogConfig.prefix = `${projectName} | `
  }

  fs.writeFileSync(configJsonPath, JSON.stringify(configData, null, 2))

  const firebaserc = {
    projects: {
      default: firebaseProjectId,
    },
  }

  fs.writeFileSync(
    path.join(projectPath, '.firebaserc'),
    JSON.stringify(firebaserc, null, 2)
  )

  const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />

    <title>${projectName}</title>
    <meta name="description" content="A tosijs-platform site" />
    <meta property="og:url" content="" />
    <meta property="og:title" content="" />
    <meta property="og:description" content="" />
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

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8')
  )
  packageJson.name = projectName
  packageJson.version = '0.1.0'
  delete packageJson.bin

  fs.writeFileSync(
    path.join(projectPath, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  )

  const setupScript = `#!/usr/bin/env node

/*
 * Setup admin user and seed initial content
 * Run after deploying functions: node setup.js
 */

import admin from 'firebase-admin'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const ADMIN_EMAIL = '${adminEmail}'
const PROJECT_ID = '${firebaseProjectId}'
const SKIP_EXISTING_DATA = ${firestoreExists}

admin.initializeApp({
  projectId: PROJECT_ID,
})

const db = admin.firestore()

async function seedFirestore() {
  if (SKIP_EXISTING_DATA) {
    console.log('Skipping seed data: database already exists')
    return
  }

  console.log('Seeding Firestore from initial_state...')
  const firestorePath = path.join(__dirname, 'initial_state/firestore')

  if (!fs.existsSync(firestorePath)) {
    console.log('  No seed data found')
    return
  }

  const files = fs.readdirSync(firestorePath).filter(f => f.endsWith('.json'))

  for (const file of files) {
    const collectionPath = file.replace(/\\.json$/, '').replace(/\\|/g, '/')
    const filePath = path.join(firestorePath, file)

    try {
      const documents = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

      if (!Array.isArray(documents)) continue

      let count = 0
      for (const doc of documents) {
        const docId = doc._id
        if (!docId) continue

        const data = { ...doc }
        delete data._id

        const now = new Date().toISOString()
        data._created = data._created || now
        data._modified = data._modified || now
        data._path = \`\${collectionPath}/\${docId}\`

        await db.collection(collectionPath).doc(docId).set(data)
        count++
      }

      console.log(\`  \${collectionPath}: \${count} documents\`)
    } catch (error) {
      console.log(\`  Error processing \${file}: \${error.message}\`)
    }
  }
}

async function setupAdminRole() {
  console.log('Setting up admin role...\\n')

  try {
    const userByEmail = await admin.auth().getUserByEmail(ADMIN_EMAIL)
    const userId = userByEmail.uid

    console.log(\`Found user: \${ADMIN_EMAIL} (uid: \${userId})\`)

    // Update the owner role document to include this user's UID
    const rolesSnapshot = await db.collection('role')
      .where('contacts', 'array-contains', { type: 'email', value: ADMIN_EMAIL })
      .get()

    if (!rolesSnapshot.empty) {
      for (const doc of rolesSnapshot.docs) {
        const data = doc.data()
        if (!data.userIds?.includes(userId)) {
          await doc.ref.update({
            userIds: admin.firestore.FieldValue.arrayUnion(userId)
          })
          console.log(\`Added uid to role: \${data.name}\`)
        } else {
          console.log(\`User already in role: \${data.name}\`)
        }
      }
    } else {
      console.log('No matching role found, creating owner role...')
      await db.collection('role').doc('owner-role').set({
        name: 'Owner',
        contacts: [{ type: 'email', value: ADMIN_EMAIL }],
        roles: ['owner', 'developer', 'admin', 'editor', 'author'],
        userIds: [userId],
        _created: new Date().toISOString(),
        _modified: new Date().toISOString(),
        _path: 'role/owner-role'
      })
    }

    console.log('\\nAdmin role setup complete!')
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      console.error(\`\\nUser \${ADMIN_EMAIL} does not exist in Firebase Auth.\`)
      console.error('\\nNext steps:')
      console.error('  1. Deploy functions: bun deploy-functions')
      console.error('  2. Deploy hosting: bun deploy-hosting')
      console.error(\`  3. Visit your site and sign in with \${ADMIN_EMAIL}\`)
      console.error('  4. Run this script again: node setup.js')
      return false
    }
    throw error
  }
  return true
}

async function setup() {
  console.log('\\nSetting up ${projectName}...\\n')

  try {
    await seedFirestore()
    console.log('')
    const success = await setupAdminRole()

    if (success) {
      console.log(\`\\nYou can now:
  1. Run: bun start
  2. Visit: https://localhost:8020
  3. Sign in with: ${adminEmail}
\`)
    }
  } catch (error) {
    console.error('Setup failed:', error.message)
    console.error('\\nMake sure:')
    console.error('  1. Functions are deployed: bun deploy-functions')
    console.error('  2. Firebase services are enabled (Auth, Firestore, Storage)')
    process.exit(1)
  }
}

setup()
`

  fs.writeFileSync(path.join(projectPath, 'setup.js'), setupScript)
  fs.chmodSync(path.join(projectPath, 'setup.js'), '755')

  console.log('📦 Installing client dependencies...')
  execCommand('bun install')

  console.log('📦 Installing function dependencies...')
  execCommand('cd functions && bun install && cd ..')

  console.log('🔐 Generating TLS certificates for local development...')
  execCommand('cd tls && ./create-dev-certs.sh && cd ..', { silent: true })

  console.log('\n✅ Project created successfully!\n')
  console.log('━'.repeat(60))
  console.log(`\n📁 Project: ${projectName}`)
  console.log(`🔥 Firebase: ${firebaseProjectId}`)
  console.log(`👤 Admin: ${adminEmail}`)
  if (firestoreExists) {
    console.log(`⚠️  Existing data: Will be preserved`)
  }
  console.log('\n━'.repeat(60))

  console.log('\n📋 Next Steps:\n')

  if (hasBlazePlan === false) {
    console.log('⚠️  FIRST: Upgrade to Blaze Plan (REQUIRED)')
    console.log(
      `   https://console.firebase.google.com/project/${firebaseProjectId}/usage/details`
    )
    console.log('   Without Blaze plan, Cloud Functions will not work!\n')
  }

  if (!firebaseConfig) {
    console.log(
      `${hasBlazePlan === false ? '1' : '1'}. Get your Firebase Web App config:`
    )
    console.log(
      `   https://console.firebase.google.com/project/${firebaseProjectId}/settings/general`
    )
    console.log(`   • Scroll to "Your apps" → Add web app (if none exist)`)
    console.log(`   • Copy the config object`)
    console.log(`   • Update src/firebase-config.ts with the values\n`)
  } else {
    console.log(
      `${
        hasBlazePlan === false ? '1' : '1'
      }. ✓ Firebase config automatically configured\n`
    )
  }

  console.log(`2. Enable Firebase services (if not already enabled):`)
  console.log(
    `   https://console.firebase.google.com/project/${firebaseProjectId}`
  )
  console.log(`   • Authentication → Google sign-in method`)
  console.log(`   • Firestore Database → Create database (production mode)`)
  console.log(`   • Cloud Storage → Get started`)
  if (hasBlazePlan !== true) {
    console.log(`   • ⚠️  UPGRADE TO BLAZE PLAN (required for Cloud Functions)`)
  }

  console.log(`\n3. Deploy Cloud Functions:`)
  console.log(`   cd ${projectName}`)
  console.log(`   bun deploy-functions`)

  console.log(`\n4. Deploy Hosting:`)
  console.log(`   bun deploy-hosting`)

  console.log(`\n5. Visit your site and sign in with ${adminEmail}`)
  console.log(`   https://${firebaseProjectId}.web.app`)

  console.log(`\n6. Run setup to grant admin access:`)
  console.log(`   node setup.js`)

  console.log(`\n7. Start local development:`)
  console.log(`   bun start`)
  console.log(`   Visit https://localhost:8020`)

  console.log('\n━'.repeat(60))
  console.log('\n📚 Custom Domain Setup:\n')
  console.log('To add a custom domain (e.g., yoursite.com):')
  console.log(
    `1. Go to: https://console.firebase.google.com/project/${firebaseProjectId}/hosting/sites`
  )
  console.log('2. Click "Add custom domain"')
  console.log('3. Follow the wizard to:')
  console.log('   • Verify domain ownership (add TXT record to DNS)')
  console.log('   • Add A/AAAA records to point to Firebase')
  console.log('4. Wait for SSL certificate provisioning (~15 minutes)')
  console.log(
    '5. Update the host field in the config/app document in Firestore:'
  )
  console.log(
    `   https://console.firebase.google.com/project/${firebaseProjectId}/firestore/data/~2Fconfig~2Fapp`
  )
  console.log(`   Set host to: yoursite.com\n`)

  console.log('━'.repeat(60))
  console.log('\n🔐 API Keys for AI Features (Optional):\n')
  console.log('If you want to use the /gen endpoint for AI completions,')
  console.log('you need to set up API keys using Firebase Secrets Manager:\n')
  console.log('  # For Gemini (Google AI):')
  console.log(
    '  firebase functions:secrets:set gemini-api-key --project ' +
      firebaseProjectId
  )
  console.log('  # Get your key at: https://aistudio.google.com/apikey\n')
  console.log('  # For ChatGPT (OpenAI):')
  console.log(
    '  firebase functions:secrets:set chatgpt-api-key --project ' +
      firebaseProjectId
  )
  console.log('  # Get your key at: https://platform.openai.com/api-keys\n')
  console.log(
    'After setting secrets, redeploy functions: bun deploy-functions\n'
  )

  console.log('━'.repeat(60))
  console.log(
    '\n📖 Documentation: https://github.com/tonioloewald/tosijs-platform'
  )
  console.log(
    '💬 Issues: https://github.com/tonioloewald/tosijs-platform/issues'
  )
  console.log('\n🎉 Happy building!\n')
}

main().catch((error) => {
  console.error('\n❌ Error:', error.message)
  process.exit(1)
})
