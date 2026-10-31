/**
 * Test environment for `functions/` tests: the test process can never reach a
 * real Firebase project.
 *
 * Kernel code reaches Firestore, Auth and Storage through the adapters, and a
 * unit test that calls through to one (installed.ts reading the epoch, say)
 * starts the Admin SDK. Without these variables the SDK falls back on gcloud's
 * application-default credentials and project, which is whatever the machine
 * last used. On 2026-10-31 that was an unrelated project, and the Store
 * conformance suite wrote its test collections into it.
 *
 * So, before any test file loads: every SDK client goes to the local
 * emulators, under a `demo-` project (the emulators' offline namespace), and
 * the application-default credentials are a dummy user whose refresh token
 * Google will refuse: the SDK starts (it reads the file at initializeApp), but a
 * client that ignored the emulator variables would fail to authenticate rather
 * than reach a real project. Tests over HTTP (the *.integration suites,
 * live-site) are untouched.
 *
 * Registered via bunfig.toml `preload`; pinned by adapters/firebase/app.test.ts.
 */
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const credentials = join(tmpdir(), 'tosijs-platform-test-credentials.json')
writeFileSync(
  credentials,
  JSON.stringify({
    type: 'authorized_user',
    quota_project_id: 'demo-test',
    client_id: 'tests.demo-test.invalid',
    client_secret: 'none',
    refresh_token: 'none: tests never authenticate to Google',
  })
)

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199'
process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9199'
process.env.GCLOUD_PROJECT = 'demo-test'
process.env.GOOGLE_CLOUD_PROJECT = 'demo-test'
process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials
