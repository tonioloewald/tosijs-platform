#!/usr/bin/env bun

/**
 * Start Firebase emulators and seed with initial_state data
 *
 * This script:
 * 1. Starts Firebase emulators in the background
 * 2. Starts a file watcher to rebuild on src changes
 * 3. Waits for "All emulators ready!" message
 * 4. Seeds the emulators with initial_state data
 * 5. Keeps emulators running in foreground
 */

import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { watch } from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

let buildTimeout = null
let isBuilding = false

async function build() {
  if (isBuilding) return
  isBuilding = true
  console.log('\n[watch] Rebuilding...')
  const start = Date.now()
  const proc = spawn('bun', ['run', 'build'], {
    stdio: 'inherit',
    cwd: projectRoot,
  })
  proc.on('close', (code) => {
    isBuilding = false
    if (code === 0) {
      console.log(`[watch] Build complete in ${Date.now() - start}ms`)
    } else {
      console.log('[watch] Build failed')
    }
  })
}

function startWatcher() {
  const srcDir = path.join(projectRoot, 'src')
  console.log('[watch] Watching src/ for changes...')

  watch(srcDir, { recursive: true }, (eventType, filename) => {
    if (filename && !filename.includes('node_modules')) {
      // Debounce rebuilds
      if (buildTimeout) clearTimeout(buildTimeout)
      buildTimeout = setTimeout(build, 100)
    }
  })
}

async function seed() {
  const seedScript = path.join(__dirname, 'seed-emulators.js')

  return new Promise((resolve, reject) => {
    const proc = spawn('bun', [seedScript], {
      stdio: 'inherit',
      cwd: projectRoot,
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Seed script exited with code ${code}`))
      }
    })

    proc.on('error', reject)
  })
}

async function main() {
  let seeded = false

  // Start file watcher for hot rebuilds
  startWatcher()

  // Start emulators
  const emulators = spawn('firebase', ['emulators:start'], {
    stdio: ['inherit', 'pipe', 'pipe'],
    cwd: projectRoot,
  })

  // Watch stdout for ready message
  emulators.stdout.on('data', async (data) => {
    const text = data.toString()
    process.stdout.write(text)

    // Look for the ready message
    if (!seeded && text.includes('All emulators ready!')) {
      seeded = true
      console.log('\n')
      try {
        await seed()
      } catch (error) {
        console.error('Seeding failed:', error.message)
      }
    }
  })

  emulators.stderr.pipe(process.stderr)

  // Handle emulator exit
  emulators.on('close', (code) => {
    process.exit(code || 0)
  })

  emulators.on('error', (error) => {
    console.error('Failed to start emulators:', error.message)
    process.exit(1)
  })

  // Keep running until killed
  process.on('SIGINT', () => {
    emulators.kill('SIGINT')
  })

  process.on('SIGTERM', () => {
    emulators.kill('SIGTERM')
  })
}

main()
