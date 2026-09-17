#!/usr/bin/env bun

/**
 * Provision a throwaway Firebase project as a deploy/test target.
 *
 * Stands up everything the platform needs on an empty Firebase project, so you
 * can deploy, install, break and reset without touching the live blog.
 *
 * ## What it does (each step is idempotent — re-running is safe)
 *
 *   1. link a billing account         — Blaze is REQUIRED; Cloud Functions v2
 *                                        will not deploy on the Spark plan
 *   2. enable the needed Google APIs
 *   3. create the Firestore database  (us-central, native mode)
 *   4. create a Web App and GENERATE `src/firebase-config.<alias>.ts` from
 *      `apps:sdkconfig` — apiKey/appId/messagingSenderId are per-project and
 *      cannot be derived from the project id, so this is the step that makes
 *      the whole thing automatable rather than a console copy-paste
 *   5. deploy functions, hosting, firestore rules and storage rules
 *   6. seed from initial_state/
 *
 * ## What it CANNOT do
 *
 * **Google sign-in must be enabled by hand, once, in the console.** Enabling an
 * OAuth sign-in provider needs an OAuth client that Firebase only provisions
 * through console flows; the Identity Toolkit admin API cannot create one. This
 * platform is Google-sign-in-only, so until you click it no human can
 * authenticate against the sandbox (anonymous/public paths still work). The
 * script prints the exact URL and stops short of pretending otherwise.
 *
 * ## Safety
 *
 * - **DRY RUN BY DEFAULT.** `--apply` is required to change anything.
 * - Targets are named by `.firebaserc` ALIAS only — never a raw project id —
 *   and the alias `default` is refused. See `sandbox-lib.js`, which holds every
 *   production guard in one auditable place.
 *
 * ## Usage
 *
 *   bun scripts/provision-sandbox.js --alias sandbox --project service-compris-test
 *   bun scripts/provision-sandbox.js --alias sandbox --apply
 *
 * `--project` is only needed the first time, to write the alias into
 * `.firebaserc`. After that the alias is enough.
 *
 * Prerequisites: `gcloud auth login` (for the access token) and
 * `firebase login`. A newer gcloud is nice but not required — billing and
 * Firestore go through REST here precisely so an old gcloud without the `beta`
 * components still works.
 */

import fs from 'fs'
import path from 'path'
import {
  projectRoot,
  FIREBASE,
  readRc,
  writeRc,
  resolveSandbox,
  productionProjectId,
  api,
  run,
  capture,
  parseArgs,
} from './sandbox-lib.js'

const { has, val } = parseArgs(process.argv)
const APPLY = has('apply')
const ALIAS = val('alias') ?? 'sandbox'
const NEW_PROJECT = val('project')
const BILLING = val('billing')
// `nam5` (US multi-region) — matches production. NOT `us-central`: that is an
// App Engine location id, and the Firestore API rejects it with a confusing
// 403 "Permission denied on 'locations/us-central' (or it may not exist)".
// Valid ids here are nam5/nam7/eur3 or regional ones like us-central1.
const LOCATION = val('location') ?? 'nam5'

const dry = !APPLY
const step = (n, title) => console.log(`\n[${n}] ${title}`)

async function main() {
  // --- Alias registration -------------------------------------------------
  const rc = readRc()
  rc.projects = rc.projects ?? {}
  if (NEW_PROJECT) {
    if (NEW_PROJECT === productionProjectId()) {
      throw new Error(
        `--project "${NEW_PROJECT}" is the production project. Refusing.`
      )
    }
    if (rc.projects[ALIAS] && rc.projects[ALIAS] !== NEW_PROJECT) {
      console.log(
        `Alias "${ALIAS}" currently points at ${rc.projects[ALIAS]}; repointing to ${NEW_PROJECT}`
      )
    }
    if (!dry) {
      rc.projects[ALIAS] = NEW_PROJECT
      writeRc(rc)
      console.log(`.firebaserc: ${ALIAS} -> ${NEW_PROJECT}`)
    } else {
      console.log(`   [dry-run] .firebaserc: ${ALIAS} -> ${NEW_PROJECT}`)
      rc.projects[ALIAS] = NEW_PROJECT
    }
  }

  // Resolve through the shared guard. Throws on anything production-shaped.
  const { projectId } =
    dry && NEW_PROJECT
      ? { projectId: NEW_PROJECT }
      : resolveSandbox(ALIAS)

  console.log(
    `\n${dry ? 'DRY RUN' : 'APPLYING'} — provisioning "${ALIAS}" (${projectId})`
  )
  console.log(`Production is "${productionProjectId()}" and is not touched.`)

  // --- 1. Billing ---------------------------------------------------------
  step(1, 'Billing (Blaze required for Cloud Functions v2)')
  const billingInfo = await api(
    'GET',
    `https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`
  )
  if (billingInfo.json?.billingEnabled) {
    console.log(`   already enabled (${billingInfo.json.billingAccountName})`)
  } else {
    let account = BILLING
    if (!account) {
      const list = await api(
        'GET',
        'https://cloudbilling.googleapis.com/v1/billingAccounts'
      )
      const open = (list.json?.billingAccounts ?? []).filter((a) => a.open)
      if (open.length === 1) {
        account = open[0].name
        console.log(`   using the only open account: ${open[0].displayName}`)
      } else {
        console.log('   Open billing accounts:')
        for (const a of open) console.log(`     ${a.name}  ${a.displayName}`)
        throw new Error(
          'Multiple open billing accounts — pass --billing billingAccounts/XXXX'
        )
      }
    }
    if (!account.startsWith('billingAccounts/')) {
      account = `billingAccounts/${account}`
    }
    if (dry) {
      console.log(`   [dry-run] link ${projectId} -> ${account}`)
    } else {
      const res = await api(
        'PUT',
        `https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`,
        { billingAccountName: account }
      )
      if (!res.ok) {
        throw new Error(`Billing link failed: ${JSON.stringify(res.json)}`)
      }
      console.log(`   linked -> ${account}`)
    }
  }

  // --- 2. APIs ------------------------------------------------------------
  step(2, 'Enable APIs')
  const SERVICES = [
    'firestore.googleapis.com',
    'firebase.googleapis.com',
    'cloudfunctions.googleapis.com',
    'cloudbuild.googleapis.com',
    'run.googleapis.com',
    'artifactregistry.googleapis.com',
    'eventarc.googleapis.com',
    'storage.googleapis.com',
    'identitytoolkit.googleapis.com',
    'firebasestorage.googleapis.com',
    // `gen.ts` calls defineSecret(), so deploy reads Secret Manager even though
    // nothing else here uses it. Without this the deploy dies late, after the
    // functions build, with a raw 403 from secretmanager.googleapis.com.
    'secretmanager.googleapis.com',
    'firebaseextensions.googleapis.com',
  ]
  run(`gcloud services enable ${SERVICES.join(' ')} --project ${projectId}`, {
    dryRun: dry,
  })

  // --- 3. Firestore -------------------------------------------------------
  step(3, `Firestore database (${LOCATION}, native mode)`)
  const existing = await api(
    'GET',
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)`
  )
  if (existing.ok) {
    console.log(`   already exists (${existing.json?.locationId ?? '?'})`)
  } else if (dry) {
    console.log(`   [dry-run] create (default) in ${LOCATION}`)
  } else {
    // REST rather than `gcloud firestore databases create` — the flag for
    // location changed between gcloud versions and this machine's is from 2022.
    const res = await api(
      'POST',
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases?databaseId=(default)`,
      { locationId: LOCATION, type: 'FIRESTORE_NATIVE' }
    )
    if (!res.ok) throw new Error(`Firestore create failed: ${JSON.stringify(res.json)}`)
    console.log('   created (this is a long-running op; it may take a minute)')
  }

  // --- 3b. Firebase Storage ------------------------------------------------
  // `firebase deploy` hard-fails with "Firebase Storage has not been set up …
  // click 'Get Started'" if the default bucket does not exist, because
  // firebase.json declares storage rules. It reads like a console-only step and
  // is not: this API does it. The empty-body call returns a bare 400
  // INVALID_ARGUMENT; `location` is required and wants a GCS location ("US"),
  // not a Firestore one ("nam5").
  step('3b', 'Firebase Storage default bucket')
  if (dry) {
    console.log('   [dry-run] create default bucket (location US)')
  } else {
    const res = await api(
      'POST',
      `https://firebasestorage.googleapis.com/v1beta/projects/${projectId}/defaultBucket`,
      { location: 'US' }
    )
    if (res.ok) {
      console.log(`   created ${res.json?.bucket?.name?.split('/').pop() ?? ''}`)
    } else if (res.status === 409) {
      console.log('   already exists')
    } else {
      throw new Error(`Storage init failed: ${JSON.stringify(res.json)}`)
    }
  }

  // --- 3c. Placeholder secrets --------------------------------------------
  // `gen.ts` declares `gemini-api-key` and `chatgpt-api-key` via defineSecret().
  // At deploy time the CLI requires each to EXIST; when one does not it prompts
  // for a value, which hangs a non-interactive run forever.
  //
  // Placeholders, deliberately: the sandbox exists to exercise the install,
  // auth and write paths, none of which call an LLM. `/gen` will fail at
  // runtime with an invalid key, which is the honest outcome — better than
  // copying a live billable credential into a throwaway project. Put a real key
  // in by hand if you ever need /gen here.
  step('3c', 'Placeholder secrets for defineSecret()')
  for (const secret of ['gemini-api-key', 'chatgpt-api-key']) {
    if (dry) {
      console.log(`   [dry-run] ensure secret ${secret}`)
      continue
    }
    const exists = await api(
      'GET',
      `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secret}`
    )
    if (exists.ok) {
      console.log(`   ${secret}: already exists`)
      continue
    }
    const created = await api(
      'POST',
      `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets?secretId=${secret}`,
      { replication: { automatic: {} } }
    )
    if (!created.ok) {
      throw new Error(`Could not create ${secret}: ${JSON.stringify(created.json)}`)
    }
    const value = Buffer.from('placeholder-not-a-real-key').toString('base64')
    const added = await api(
      'POST',
      `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secret}:addVersion`,
      { payload: { data: value } }
    )
    if (!added.ok) {
      throw new Error(`Could not seed ${secret}: ${JSON.stringify(added.json)}`)
    }
    console.log(`   ${secret}: created with a placeholder value`)
  }

  // --- 4. Web app + generated client config -------------------------------
  step(4, 'Web app and client config')
  const configFile = path.join(projectRoot, 'src', `firebase-config.${ALIAS}.ts`)
  if (fs.existsSync(configFile)) {
    console.log(`   ${path.relative(projectRoot, configFile)} exists — leaving it`)
  } else if (dry) {
    console.log(`   [dry-run] apps:create WEB, then write ${path.relative(projectRoot, configFile)}`)
  } else {
    let appId
    try {
      const list = capture(`${FIREBASE} apps:list WEB --project ${projectId} --json`)
      appId = (JSON.parse(list)?.result ?? [])[0]?.appId
    } catch {
      /* fall through to create */
    }
    if (!appId) {
      run(`${FIREBASE} apps:create WEB "${ALIAS}" --project ${projectId}`, {
        dryRun: false,
      })
      const list = capture(`${FIREBASE} apps:list WEB --project ${projectId} --json`)
      appId = (JSON.parse(list)?.result ?? [])[0]?.appId
    }
    if (!appId) throw new Error('Could not determine the web appId')
    const sdk = JSON.parse(
      capture(`${FIREBASE} apps:sdkconfig WEB ${appId} --project ${projectId} --json`)
    )
    const c = sdk?.result?.sdkConfig ?? sdk?.sdkConfig ?? {}
    fs.writeFileSync(
      configFile,
      `// GENERATED by scripts/provision-sandbox.js — do not hand-edit.\n` +
        `// Sandbox project "${ALIAS}". Gitignored, like every firebase-config.\n` +
        `const PROJECT_ID = '${projectId}'\n\n` +
        `export const PRODUCTION_BASE = \`//us-central1-\${PROJECT_ID}.cloudfunctions.net/\`\n\n` +
        `export const config = {\n` +
        `  authDomain: \`\${PROJECT_ID}.firebaseapp.com\`,\n` +
        `  projectId: PROJECT_ID,\n` +
        `  storageBucket: '${c.storageBucket ?? `${projectId}.appspot.com`}',\n` +
        `  apiKey: '${c.apiKey ?? ''}',\n` +
        `  messagingSenderId: '${c.messagingSenderId ?? ''}',\n` +
        `  appId: '${c.appId ?? appId}',\n` +
        `}\n`
    )
    console.log(`   wrote ${path.relative(projectRoot, configFile)}`)
  }

  // --- 5. Deploy ----------------------------------------------------------
  step(5, 'Deploy')
  // Point the checkout at the sandbox BEFORE building. Without this the client
  // is built from whatever `src/firebase-config.ts` happens to hold — which is
  // production — and that bundle then gets deployed to the sandbox's hosting,
  // so the sandbox site would read and WRITE the live database. This is the
  // exact client/CLI mismatch `use-project.js` exists to prevent, and the
  // provisioner walked straight into it.
  run(`bun scripts/use-project.js ${ALIAS}`, { dryRun: dry })
  run('bun run build', { dryRun: dry })
  run('bun run build', { dryRun: dry, cwd: path.join(projectRoot, 'functions') })
  // `--force` accepts the Artifact Registry cleanup-policy prompt. Without it a
  // FULLY SUCCESSFUL deploy still exits non-zero ("could not set up cleanup
  // policy"), which reads as a failed deploy and stops the script one step from
  // the finish line. The policy is also worth having: it expires old container
  // images that otherwise accrue a small monthly bill forever.
  run(`${FIREBASE} deploy -P ${ALIAS} --force`, { dryRun: dry })

  // --- 6. Seed ------------------------------------------------------------
  step(6, 'Seed from initial_state/')
  run(`bun scripts/seed-production.js --project ${projectId}`, { dryRun: dry })

  // --- The manual step ----------------------------------------------------
  console.log('\n' + '='.repeat(70))
  if (dry) {
    console.log('DRY RUN — nothing was changed. Re-run with --apply.')
  } else {
    console.log(`Sandbox "${ALIAS}" (${projectId}) is provisioned.`)
  }
  console.log('='.repeat(70))
  console.log(
    '\nONE MANUAL STEP REMAINS — Google sign-in cannot be enabled from the CLI:\n' +
      `  https://console.firebase.google.com/project/${projectId}/authentication/providers\n` +
      '  Enable "Google" as a sign-in provider.\n' +
      '\nUntil then no human can sign in to the sandbox; public/anonymous paths work.\n' +
      `\nThen:  bun run use ${ALIAS}     # point this checkout at it\n` +
      `       bun run sandbox:reset    # wipe + reseed whenever you want a clean slate\n`
  )
}

main().catch((e) => {
  console.error(`\nprovision-sandbox failed: ${e.message}`)
  process.exit(1)
})
