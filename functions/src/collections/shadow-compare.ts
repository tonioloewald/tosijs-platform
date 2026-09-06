/**
 * Shadow-mode comparison for the write pipeline (ROADMAP Phase 1, rung 1:
 * "run in shadow mode — compute alongside the current TS, commit nothing —
 * until the diff is clean, then cut over").
 *
 * This re-derives what `write-pipeline.ts` WOULD have produced for a write that
 * `doc.ts` has already decided, and logs any divergence. It never influences the
 * response, never writes, and never throws into the request path.
 *
 * ## Enabling it (the operational half — F7)
 *
 * Set `SHADOW_WRITE_PIPELINE=1` in the functions runtime environment. For a
 * deployed v2 function that means `functions/.env` (committed per-project by
 * Firebase convention) or `--set-env-vars` on the underlying Cloud Run service:
 *
 * ```sh
 * # local, against emulators
 * SHADOW_WRITE_PIPELINE=1 npx firebase-tools emulators:start --only functions,firestore
 *
 * # deployed — redeploy with the var set in functions/.env
 * echo 'SHADOW_WRITE_PIPELINE=1' >> functions/.env && bun deploy-functions
 * ```
 *
 * Then read the divergence in Cloud Logging:
 * `resource.type="cloud_run_revision" jsonPayload.message=~"^\[shadow\]"`.
 * `[shadow] match` is the good line; `MISMATCH` is the one to act on, and
 * `expected-noop` is the known §3 divergence awaiting cutover.
 *
 * **Cutover criteria** (record the outcome in ROADMAP before flipping): zero
 * `MISMATCH body` and zero `MISMATCH pipeline-rejected` across a representative
 * sample of real writes covering every registered collection — then the only
 * remaining difference is `expected-noop`, which is the intended behaviour change.
 *
 * ## Off by default
 *
 * Enabled only when `SHADOW_WRITE_PIPELINE=1`. A shadow that runs unasked on the
 * production write path is a liability, not a diagnostic: it doubles the transform
 * and can only ever cost latency. Deploying it inert means turning it on later is
 * a config change to an already-reviewed code path rather than a fresh deploy of
 * untested code.
 *
 * ## What is compared, and what deliberately is not
 *
 * Compared: the document body that would be written. That is the thing whose
 * divergence would corrupt data.
 *
 * Not compared:
 *  - **Uniqueness.** The real path already performed those privileged reads and
 *    rejected on collision; re-running them would double the read cost to learn
 *    nothing, so the shadow stubs `isUnique` to true. Ordering around uniqueness
 *    is covered by unit tests instead (write-pipeline.test.ts).
 *  - **The clock.** The real path's `_modified` is injected, so a shadow run can
 *    never diverge merely by being a few milliseconds later.
 *
 * ## The expected divergence
 *
 * The pipeline implements §3's no-op check and `doc.ts` does not, so an unchanged
 * body legitimately yields `noop` here against a real write there. That is
 * reported as `expected-noop` rather than a mismatch — it is the known behaviour
 * change awaiting cutover, and burying it in the mismatch count would hide the
 * unknown divergences this exists to find.
 */
import * as functions from 'firebase-functions'
import { runWritePipeline, type WriteMethod } from './write-pipeline'
import type { CollectionConfig } from './access'
import type { UserRoles } from './roles'

export const shadowEnabled = (): boolean =>
  process.env.SHADOW_WRITE_PIPELINE === '1'

/** Stable, key-order-independent compare so field order is never a "difference". */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`
}

function differingKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => stable(a[k]) !== stable(b[k])).sort()
}

/**
 * Compare the pipeline's would-be result against what `doc.ts` actually wrote.
 * Returns nothing and throws nothing — failures are logged and swallowed, because
 * a diagnostic that can break a save is worse than no diagnostic.
 */
export async function shadowCompareWrite(params: {
  path: string
  method: WriteMethod
  /** the caller's body, before doc.ts merged/stamped it */
  body: Record<string, unknown>
  existing: Record<string, unknown>
  config: CollectionConfig
  userRoles: UserRoles
  /** what doc.ts is about to commit */
  actual: Record<string, unknown>
  /** the `_modified` doc.ts stamped, injected so clocks cannot diverge */
  now: string
}): Promise<void> {
  try {
    const outcome = await runWritePipeline(
      {
        method: params.method,
        body: params.body,
        existing: params.existing,
        config: params.config,
        userRoles: params.userRoles,
      },
      { now: () => params.now, isUnique: async () => true }
    )

    if (outcome.status === 'noop') {
      functions.logger.info('[shadow] expected-noop', {
        path: params.path,
        method: params.method,
        note: 'pipeline would skip this write (§3 no-op); doc.ts rewrites and re-stamps',
      })
      return
    }

    if (outcome.status === 'rejected') {
      functions.logger.warn('[shadow] MISMATCH pipeline-rejected', {
        path: params.path,
        method: params.method,
        reason: outcome.reason,
        message: outcome.message,
        note: 'doc.ts accepted this write; the pipeline would have refused it',
      })
      return
    }

    const keys = differingKeys(outcome.data, params.actual)
    if (keys.length > 0) {
      // Log KEY NAMES and a compact shape, never full document bodies — this runs
      // on real user content and logs are a different trust domain.
      functions.logger.warn('[shadow] MISMATCH body', {
        path: params.path,
        method: params.method,
        differingKeys: keys,
        detail: keys.map((k) => ({
          key: k,
          pipeline: typeof outcome.data[k],
          actual: typeof params.actual[k],
          pipelineMissing: !(k in outcome.data),
          actualMissing: !(k in params.actual),
        })),
      })
    } else {
      functions.logger.debug('[shadow] match', {
        path: params.path,
        method: params.method,
      })
    }
  } catch (e) {
    functions.logger.warn('[shadow] comparison failed (ignored)', {
      path: params.path,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
