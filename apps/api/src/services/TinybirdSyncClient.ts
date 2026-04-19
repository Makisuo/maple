import type { OrgId } from "@maple/domain/http"
import {
  type TinybirdDeploymentReadiness,
  type TinybirdInstanceHealth,
  type TinybirdProjectSyncParams,
  TinybirdProjectSync,
  type TinybirdSyncRejectedError,
  type TinybirdSyncUnavailableError,
} from "@maple/domain/tinybird-project-sync"
import { Context, Effect, Layer } from "effect"
import { WorkerEnvironment } from "./WorkerEnvironment"

const TINYBIRD_SYNC_WORKFLOW_BINDING_KEY = "TINYBIRD_SYNC_WORKFLOW"

export interface TinybirdSyncWorkflowBinding {
  readonly create: (options?: {
    readonly id?: string
    readonly params?: { readonly orgId: OrgId }
  }) => Promise<unknown>
}

export class TinybirdWorkflowKickoffError extends Error {
  readonly _tag = "@maple/tinybird/errors/WorkflowKickoff" as const
  constructor(message: string, readonly cause?: unknown) {
    super(message)
  }
}

type DeploymentParams = TinybirdProjectSyncParams & { readonly deploymentId: string }

export interface TinybirdSyncClientShape {
  readonly getDeploymentStatus: (
    params: DeploymentParams,
  ) => Effect.Effect<TinybirdDeploymentReadiness, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly cleanupOwnedDeployment: (
    params: DeploymentParams,
  ) => Effect.Effect<void, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly fetchInstanceHealth: (
    params: TinybirdProjectSyncParams,
  ) => Effect.Effect<TinybirdInstanceHealth, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly getProjectRevision: () => Effect.Effect<string>
  readonly startWorkflow: (orgId: OrgId) => Effect.Effect<void, TinybirdWorkflowKickoffError>
}

const isWorkflowBinding = (value: unknown): value is TinybirdSyncWorkflowBinding =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { create?: unknown }).create === "function"

export class TinybirdSyncClient extends Context.Service<TinybirdSyncClient, TinybirdSyncClientShape>()(
  "TinybirdSyncClient",
  {
    make: Effect.gen(function* () {
      const sync = yield* TinybirdProjectSync
      const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)

      const startWorkflow = Effect.fn("TinybirdSyncClient.startWorkflow")(function* (orgId: OrgId) {
        yield* Effect.annotateCurrentSpan("orgId", orgId)
        const env = workerEnv._tag === "Some" ? workerEnv.value : ({} as Record<string, unknown>)
        const binding = env[TINYBIRD_SYNC_WORKFLOW_BINDING_KEY]
        if (!isWorkflowBinding(binding)) {
          return yield* Effect.fail(
            new TinybirdWorkflowKickoffError(
              `Missing Cloudflare Workflow binding: ${TINYBIRD_SYNC_WORKFLOW_BINDING_KEY}`,
            ),
          )
        }
        yield* Effect.tryPromise({
          try: () => binding.create({ params: { orgId } }),
          catch: (error) =>
            new TinybirdWorkflowKickoffError(
              error instanceof Error
                ? `Failed to start Tinybird sync workflow: ${error.message}`
                : "Failed to start Tinybird sync workflow",
              error,
            ),
        })
      })

      return {
        getDeploymentStatus: sync.getDeploymentStatus,
        cleanupOwnedDeployment: sync.cleanupOwnedDeployment,
        fetchInstanceHealth: sync.fetchInstanceHealth,
        getProjectRevision: () => sync.getCurrentProjectRevision(),
        startWorkflow,
      }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provideMerge(TinybirdProjectSync.layer),
  )
  static readonly Default = this.layer
}
