import { orgTinybirdSettings, orgTinybirdSyncRuns } from "@maple/db"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import {
  cleanupStaleTinybirdDeployments,
  pollTinybirdDeploymentStep,
  setTinybirdDeploymentLiveStep,
  startTinybirdDeploymentStep,
  TinybirdDeploymentNotReadyError,
} from "@maple/domain/tinybird-project-sync"
import {
  decryptAes256Gcm,
  parseBase64Aes256GcmKey,
} from "../services/Crypto"
import { Database } from "../services/DatabaseLive"
import { DatabaseD1Live } from "../services/DatabaseD1Live"
import { WorkerEnvironment } from "../services/WorkerEnvironment"

export interface TinybirdSyncWorkflowPayload {
  readonly orgId: string
}

export interface TinybirdSyncWorkflowResult {
  readonly orgId: string
  readonly result: "succeeded" | "failed" | "no_changes"
  readonly deploymentId: string | null
  readonly errorMessage: string | null
}

interface SyncRunSnapshot {
  readonly orgId: string
  readonly requestedBy: string
  readonly targetHost: string
  readonly targetTokenCiphertext: string
  readonly targetTokenIv: string
  readonly targetTokenTag: string
  readonly targetProjectRevision: string
  readonly deploymentId: string | null
}

export interface WorkflowEventLike<T> {
  readonly payload: T
}

type StepCallback<T> = () => Promise<T>

type StepConfig = {
  readonly retries?: {
    readonly limit: number
    readonly delay: string | number
    readonly backoff?: string
  }
}

/**
 * Minimal structural subset of Cloudflare's `WorkflowStep` so this module can
 * be imported from unit tests without the `cloudflare:workers` runtime.
 */
export interface WorkflowStepLike {
  do<T>(name: string, callback: StepCallback<T>): Promise<T>
  do<T>(name: string, config: StepConfig, callback: StepCallback<T>): Promise<T>
}

// ---------------------------------------------------------------------------
// Effect plumbing
// ---------------------------------------------------------------------------

const defaultAppLayer = (env: Record<string, unknown>): Layer.Layer<Database> =>
  DatabaseD1Live.pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, env as Record<string, any>)),
  )

const runStep = <A, E>(
  appLayer: Layer.Layer<Database>,
  effect: Effect.Effect<A, E, Database>,
): Promise<A> => {
  const provided = effect.pipe(Effect.provide(appLayer)) as Effect.Effect<A, E, never>
  return Effect.runPromise(provided)
}

// ---------------------------------------------------------------------------
// DB helpers (Effect-wrapped Drizzle)
// ---------------------------------------------------------------------------

const readSyncRun = (orgId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const rows = yield* database.execute((db) =>
      db
        .select()
        .from(orgTinybirdSyncRuns)
        .where(eq(orgTinybirdSyncRuns.orgId, orgId))
        .limit(1),
    )
    const row = rows[0]
    if (!row) {
      return yield* Effect.die(new Error(`No sync run row found for org ${orgId}`))
    }
    return row satisfies typeof orgTinybirdSyncRuns.$inferSelect
  })

type SyncRunPatch = Partial<Omit<typeof orgTinybirdSyncRuns.$inferInsert, "orgId">>

const updateSyncRun = (orgId: string, patch: SyncRunPatch) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.execute((db) =>
      db
        .update(orgTinybirdSyncRuns)
        .set({ ...patch, updatedAt: patch.updatedAt ?? Date.now() })
        .where(eq(orgTinybirdSyncRuns.orgId, orgId)),
    )
  })

const promoteActiveConfig = (
  orgId: string,
  row: SyncRunSnapshot,
  projectRevision: string,
  deploymentId: string | null,
) =>
  Effect.gen(function* () {
    const database = yield* Database
    const now = Date.now()
    yield* database.execute((db) =>
      db
        .insert(orgTinybirdSettings)
        .values({
          orgId,
          host: row.targetHost,
          tokenCiphertext: row.targetTokenCiphertext,
          tokenIv: row.targetTokenIv,
          tokenTag: row.targetTokenTag,
          syncStatus: "active",
          lastSyncAt: now,
          lastSyncError: null,
          projectRevision,
          lastDeploymentId: deploymentId,
          createdAt: now,
          updatedAt: now,
          createdBy: row.requestedBy,
          updatedBy: row.requestedBy,
        })
        .onConflictDoUpdate({
          target: orgTinybirdSettings.orgId,
          set: {
            host: row.targetHost,
            tokenCiphertext: row.targetTokenCiphertext,
            tokenIv: row.targetTokenIv,
            tokenTag: row.targetTokenTag,
            syncStatus: "active",
            lastSyncAt: now,
            lastSyncError: null,
            projectRevision,
            lastDeploymentId: deploymentId,
            updatedAt: now,
            updatedBy: row.requestedBy,
          },
        }),
    )
  })

const resolveToken = (
  env: Record<string, unknown>,
  row: SyncRunSnapshot,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const rawKey = env.MAPLE_INGEST_KEY_ENCRYPTION_KEY
    if (typeof rawKey !== "string" || rawKey.trim().length === 0) {
      return yield* Effect.fail(new Error("Missing MAPLE_INGEST_KEY_ENCRYPTION_KEY in workflow env"))
    }

    const key = yield* parseBase64Aes256GcmKey(rawKey, (message) => new Error(message))

    return yield* decryptAes256Gcm(
      {
        ciphertext: row.targetTokenCiphertext,
        iv: row.targetTokenIv,
        tag: row.targetTokenTag,
      },
      key,
      () => new Error("Failed to decrypt Tinybird token in workflow"),
    )
  })

const toSnapshot = (row: typeof orgTinybirdSyncRuns.$inferSelect): SyncRunSnapshot => ({
  orgId: row.orgId,
  requestedBy: row.requestedBy,
  targetHost: row.targetHost,
  targetTokenCiphertext: row.targetTokenCiphertext,
  targetTokenIv: row.targetTokenIv,
  targetTokenTag: row.targetTokenTag,
  targetProjectRevision: row.targetProjectRevision,
  deploymentId: row.deploymentId,
})

// ---------------------------------------------------------------------------
// Step configs
// ---------------------------------------------------------------------------

const POLL_STEP_CONFIG: StepConfig = {
  retries: {
    limit: 60,
    delay: "2 seconds",
    backoff: "constant",
  },
}

const DEFAULT_STEP_CONFIG: StepConfig = {
  retries: {
    limit: 5,
    delay: "2 seconds",
    backoff: "exponential",
  },
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunTinybirdSyncOptions {
  /** Override the Database layer — tests pass a libsql-backed layer. */
  readonly appLayer?: Layer.Layer<Database>
}

export const runTinybirdSyncWorkflow = async (
  env: Record<string, unknown>,
  event: WorkflowEventLike<TinybirdSyncWorkflowPayload>,
  step: WorkflowStepLike,
  options?: RunTinybirdSyncOptions,
): Promise<TinybirdSyncWorkflowResult> => {
  const appLayer = options?.appLayer ?? defaultAppLayer(env)
  const { orgId } = event.payload

  const markFailed = (errorMessage: string) =>
    step.do("mark-failed", DEFAULT_STEP_CONFIG, async () => {
      await runStep(
        appLayer,
        updateSyncRun(orgId, {
          runStatus: "failed",
          phase: "failed",
          errorMessage,
          finishedAt: Date.now(),
        }),
      )
    })

  try {
    const snapshot = await step.do("load-sync-run", DEFAULT_STEP_CONFIG, async () =>
      runStep(appLayer, readSyncRun(orgId).pipe(Effect.map(toSnapshot))))

    const token = await step.do("decrypt-token", async () =>
      runStep(appLayer, resolveToken(env, snapshot)))

    await step.do("mark-running", DEFAULT_STEP_CONFIG, async () => {
      await runStep(appLayer,
        updateSyncRun(orgId, {
          runStatus: "running",
          phase: "starting",
          errorMessage: null,
        }),
      )
    })

    await step.do("cleanup-stale-deployments", DEFAULT_STEP_CONFIG, async () => {
      try {
        await cleanupStaleTinybirdDeployments({ baseUrl: snapshot.targetHost, token })
      } catch (error) {
        console.warn(`cleanup-stale-deployments failed for org ${orgId}:`, error)
      }
    })

    const started = await step.do("start-deployment", async () =>
      startTinybirdDeploymentStep({ baseUrl: snapshot.targetHost, token }))

    if (started.result === "no_changes") {
      // Tinybird's `no_changes` response may include a phantom `deployment`
      // object that doesn't actually exist server-side. Don't store its id or
      // status — the existing live deployment is unchanged, so we mark the
      // BYO settings active without owning a tracked deployment id.
      await step.do("promote-no-changes", DEFAULT_STEP_CONFIG, async () => {
        await runStep(appLayer,
          promoteActiveConfig(orgId, snapshot, started.projectRevision, null),
        )
        await runStep(appLayer,
          updateSyncRun(orgId, {
            runStatus: "succeeded",
            phase: "succeeded",
            deploymentId: null,
            deploymentStatus: "live",
            errorMessage: null,
            finishedAt: Date.now(),
          }),
        )
      })

      return {
        orgId,
        result: "no_changes",
        deploymentId: null,
        errorMessage: null,
      }
    }

    if (!started.deploymentId) {
      const message = "Tinybird project sync did not return a deployment id"
      await markFailed(message)
      return { orgId, result: "failed", deploymentId: null, errorMessage: message }
    }

    const deploymentId = started.deploymentId

    await step.do("mark-deploying", DEFAULT_STEP_CONFIG, async () => {
      await runStep(appLayer,
        updateSyncRun(orgId, {
          runStatus: "running",
          phase: "deploying",
          deploymentId,
          deploymentStatus: started.deploymentStatus ?? "deploying",
          errorMessage: null,
        }),
      )
    })

    const readiness = await step.do("poll-deployment", POLL_STEP_CONFIG, async () =>
      pollTinybirdDeploymentStep({ baseUrl: snapshot.targetHost, token, deploymentId }))

    await step.do("mark-setting-live", DEFAULT_STEP_CONFIG, async () => {
      await runStep(appLayer,
        updateSyncRun(orgId, {
          runStatus: "running",
          phase: "setting_live",
          deploymentStatus: readiness.status,
          errorMessage: null,
        }),
      )
    })

    if (readiness.status !== "live") {
      await step.do("set-live", DEFAULT_STEP_CONFIG, async () =>
        setTinybirdDeploymentLiveStep({ baseUrl: snapshot.targetHost, token, deploymentId }))
    }

    await step.do("promote-active-config", DEFAULT_STEP_CONFIG, async () => {
      await runStep(appLayer,
        promoteActiveConfig(orgId, snapshot, snapshot.targetProjectRevision, deploymentId),
      )
    })

    await step.do("mark-succeeded", DEFAULT_STEP_CONFIG, async () => {
      await runStep(appLayer,
        updateSyncRun(orgId, {
          runStatus: "succeeded",
          phase: "succeeded",
          deploymentStatus: "live",
          errorMessage: null,
          finishedAt: Date.now(),
        }),
      )
    })

    return { orgId, result: "succeeded", deploymentId, errorMessage: null }
  } catch (error) {
    // Not-ready bubbles up so Cloudflare's step retry fires.
    if (error instanceof TinybirdDeploymentNotReadyError) {
      throw error
    }
    const message = error instanceof Error ? error.message : "Tinybird sync failed"
    await markFailed(message)
    return { orgId, result: "failed", deploymentId: null, errorMessage: message }
  }
}
