import { orgTinybirdSettings, orgTinybirdSyncRuns } from "@maple/db"
import { OrgId, UserId } from "@maple/domain/http"
import {
  cleanupStaleTinybirdDeployments,
  pollTinybirdDeploymentStep,
  setTinybirdDeploymentLiveStep,
  startTinybirdDeploymentStep,
  TinybirdDeploymentNotReadyError,
} from "@maple/domain/tinybird-project-sync"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { decryptAes256Gcm, parseBase64Aes256GcmKey } from "../services/Crypto"
import { DatabaseD1Live } from "../services/DatabaseD1Live"
import { Database } from "../services/DatabaseLive"
import { WorkerEnvironment } from "../services/WorkerEnvironment"

export class TinybirdSyncRunMissingError extends Schema.TaggedErrorClass<TinybirdSyncRunMissingError>()(
  "@maple/tinybird/errors/SyncRunMissing",
  {
    orgId: Schema.String,
    message: Schema.String,
  },
) {}

export class TinybirdWorkflowTokenError extends Schema.TaggedErrorClass<TinybirdWorkflowTokenError>()(
  "@maple/tinybird/errors/WorkflowTokenError",
  {
    message: Schema.String,
  },
) {}

export interface TinybirdSyncWorkflowPayload {
  readonly orgId: OrgId
}

export interface TinybirdSyncWorkflowResult {
  readonly orgId: OrgId
  readonly result: "succeeded" | "failed" | "no_changes"
  readonly deploymentId: string | null
  readonly errorMessage: string | null
}

interface SyncRunSnapshot {
  readonly orgId: OrgId
  readonly requestedBy: UserId
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

// Minimal structural subset of Cloudflare's `WorkflowStep` so this module can
// be imported from unit tests without the `cloudflare:workers` runtime.
export interface WorkflowStepLike {
  do<T>(name: string, callback: StepCallback<T>): Promise<T>
  do<T>(name: string, config: StepConfig, callback: StepCallback<T>): Promise<T>
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

const decodeOrgId = Schema.decodeUnknownSync(OrgId)
const decodeUserId = Schema.decodeUnknownSync(UserId)

// ---------------------------------------------------------------------------
// Effect plumbing
// ---------------------------------------------------------------------------

const defaultAppLayer = (env: Record<string, unknown>) =>
  DatabaseD1Live.pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, env)),
  )

const runStep = <A, E>(
  appLayer: Layer.Layer<Database>,
  effect: Effect.Effect<A, E, Database>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(appLayer)))

// ---------------------------------------------------------------------------
// DB helpers (Effect.fn — annotated spans + typed errors)
// ---------------------------------------------------------------------------

const readSyncRun = Effect.fn("TinybirdSyncWorkflow.readSyncRun")(function* (orgId: OrgId) {
  yield* Effect.annotateCurrentSpan("orgId", orgId)
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
    return yield* Effect.fail(
      new TinybirdSyncRunMissingError({
        orgId,
        message: `No sync run row found for org ${orgId}`,
      }),
    )
  }
  return row
})

type SyncRunPatch = Partial<Omit<typeof orgTinybirdSyncRuns.$inferInsert, "orgId">>

const updateSyncRun = Effect.fn("TinybirdSyncWorkflow.updateSyncRun")(
  function* (orgId: OrgId, patch: SyncRunPatch) {
    yield* Effect.annotateCurrentSpan("orgId", orgId)
    const database = yield* Database
    yield* database.execute((db) =>
      db
        .update(orgTinybirdSyncRuns)
        .set({ ...patch, updatedAt: patch.updatedAt ?? Date.now() })
        .where(eq(orgTinybirdSyncRuns.orgId, orgId)),
    )
  },
)

const promoteActiveConfig = Effect.fn("TinybirdSyncWorkflow.promoteActiveConfig")(
  function* (
    orgId: OrgId,
    row: SyncRunSnapshot,
    projectRevision: string,
    deploymentId: string | null,
  ) {
    yield* Effect.annotateCurrentSpan("orgId", orgId)
    if (deploymentId !== null) {
      yield* Effect.annotateCurrentSpan("deploymentId", deploymentId)
    }
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
  },
)

const resolveToken = Effect.fn("TinybirdSyncWorkflow.resolveToken")(
  function* (env: Record<string, unknown>, row: SyncRunSnapshot) {
    const rawKey = env.MAPLE_INGEST_KEY_ENCRYPTION_KEY
    if (typeof rawKey !== "string" || rawKey.trim().length === 0) {
      return yield* Effect.fail(
        new TinybirdWorkflowTokenError({
          message: "Missing MAPLE_INGEST_KEY_ENCRYPTION_KEY in workflow env",
        }),
      )
    }

    const key = yield* parseBase64Aes256GcmKey(
      rawKey,
      (message) => new TinybirdWorkflowTokenError({ message }),
    )

    return yield* decryptAes256Gcm(
      {
        ciphertext: row.targetTokenCiphertext,
        iv: row.targetTokenIv,
        tag: row.targetTokenTag,
      },
      key,
      () =>
        new TinybirdWorkflowTokenError({
          message: "Failed to decrypt Tinybird token in workflow",
        }),
    )
  },
)

const toSnapshot = (row: typeof orgTinybirdSyncRuns.$inferSelect): SyncRunSnapshot => ({
  orgId: decodeOrgId(row.orgId),
  requestedBy: decodeUserId(row.requestedBy),
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
  // Override the Database layer — tests pass a libsql-backed layer.
  readonly appLayer?: Layer.Layer<Database>
}

const logCleanupWarning = (orgId: OrgId, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "tinybird-sync.cleanup-stale-deployments.failed",
      orgId,
      message,
    }),
  )
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
      await runStep(
        appLayer,
        updateSyncRun(orgId, {
          runStatus: "running",
          phase: "starting",
          errorMessage: null,
        }),
      )
    })

    await step.do("cleanup-stale-deployments", DEFAULT_STEP_CONFIG, async () => {
      // Best-effort cleanup — failures are logged structurally and swallowed so
      // the sync can proceed even if the stale-deployment list endpoint is
      // temporarily unavailable.
      try {
        await cleanupStaleTinybirdDeployments({ baseUrl: snapshot.targetHost, token })
      } catch (error) {
        logCleanupWarning(orgId, error)
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
        await runStep(
          appLayer,
          promoteActiveConfig(orgId, snapshot, started.projectRevision, null),
        )
        await runStep(
          appLayer,
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
      await runStep(
        appLayer,
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
      await runStep(
        appLayer,
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
      await runStep(
        appLayer,
        promoteActiveConfig(orgId, snapshot, snapshot.targetProjectRevision, deploymentId),
      )
    })

    await step.do("mark-succeeded", DEFAULT_STEP_CONFIG, async () => {
      await runStep(
        appLayer,
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

