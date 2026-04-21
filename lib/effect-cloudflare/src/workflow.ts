// Simplified port of alchemy-effect's Workflow factory:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/Workflow.ts
//
// Upstream couples the Workflow class to the alchemy IaC Worker resource
// (automatic binding registration + `WorkflowResource` provider for the
// Cloudflare Workflows API). This port drops the IaC half and keeps the
// runtime half:
//
//   export class TinybirdSyncWorkflow extends Workflow<{ orgId: string }>()(
//     "TinybirdSyncWorkflow",
//     Effect.gen(function* () {
//       return Effect.gen(function* () {
//         const event = yield* WorkflowEvent
//         yield* task("sync", syncEffect(event.payload))
//         yield* sleep("cooldown", "5 seconds")
//       })
//     }),
//   ) {}
//
// For instance creation/lookup from worker code, use `workflowHandle(name)`.
//
// IMPORTANT: This module statically imports from `cloudflare:workers`; it can
// only be loaded inside a Cloudflare Worker isolate.
import { WorkflowEntrypoint } from "cloudflare:workers"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { makeWorkflowBridge } from "./rpc.ts"
import { WorkerEnvironment } from "./worker-environment.ts"

// ---------------------------------------------------------------------------
// Runtime services provided by the bridge while a workflow executes
// ---------------------------------------------------------------------------

export class WorkflowEvent extends Context.Service<
  WorkflowEvent,
  {
    payload: unknown
    timestamp: Date
    instanceId: string
  }
>()("Cloudflare.WorkflowEvent") {}

export class WorkflowStep extends Context.Service<
  WorkflowStep,
  {
    do<T>(name: string, effect: Effect.Effect<T>): Effect.Effect<T>
    sleep(name: string, duration: string | number): Effect.Effect<void>
    sleepUntil(name: string, timestamp: Date | number): Effect.Effect<void>
  }
>()("Cloudflare.WorkflowStep") {}

// ---------------------------------------------------------------------------
// Step primitives — thin wrappers over WorkflowStep methods
// ---------------------------------------------------------------------------

export const task = <T>(
  name: string,
  effect: Effect.Effect<T>,
): Effect.Effect<T, never, WorkflowStep> =>
  WorkflowStep.asEffect().pipe(Effect.flatMap((step) => step.do(name, effect)))

export const sleep = (
  name: string,
  duration: string | number,
): Effect.Effect<void, never, WorkflowStep> =>
  WorkflowStep.asEffect().pipe(
    Effect.flatMap((step) => step.sleep(name, duration)),
    Effect.orDie,
  )

export const sleepUntil = (
  name: string,
  timestamp: Date | number,
): Effect.Effect<void, never, WorkflowStep> =>
  WorkflowStep.asEffect().pipe(
    Effect.flatMap((step) => step.sleepUntil(name, timestamp)),
    Effect.orDie,
  )

export type WorkflowRunServices = WorkflowEvent | WorkflowStep

export type WorkflowBody<Result = unknown> = Effect.Effect<
  Result,
  never,
  WorkflowRunServices
>

// ---------------------------------------------------------------------------
// Handles returned to worker code for starting / inspecting instances
// ---------------------------------------------------------------------------

export interface WorkflowHandle {
  readonly name: string
  create(params?: unknown): Effect.Effect<WorkflowInstance>
  get(instanceId: string): Effect.Effect<WorkflowInstance>
}

export interface WorkflowInstance {
  readonly id: string
  status(): Effect.Effect<WorkflowInstanceStatus>
  pause(): Effect.Effect<void>
  resume(): Effect.Effect<void>
  terminate(): Effect.Effect<void>
}

export interface WorkflowInstanceStatus {
  status: string
  output?: unknown
  error?: { name: string; message: string } | null
}

// ---------------------------------------------------------------------------
// Module-level impl registry (mirrors the DO namespace registry)
// ---------------------------------------------------------------------------

type WorkflowImpl = Effect.Effect<WorkflowBody, never, any>

const implRegistry = new Map<string, WorkflowImpl>()

export const registerWorkflowImpl = (
  name: string,
  impl: WorkflowImpl,
): void => {
  implRegistry.set(name, impl)
}

// ---------------------------------------------------------------------------
// Bridge base class
// ---------------------------------------------------------------------------

const Bridge = makeWorkflowBridge(
  WorkflowEntrypoint as unknown as abstract new (
    ctx: unknown,
    env: unknown,
  ) => { run(event: any, step: any): Promise<unknown> },
  async (name: string) => {
    const impl = implRegistry.get(name)
    if (!impl) {
      throw new Error(
        `Workflow impl for '${name}' is not registered. Ensure the class module is loaded before CF instantiates the workflow.`,
      )
    }
    return (env: unknown) =>
      impl.pipe(
        Effect.provideService(
          WorkerEnvironment,
          env as Record<string, unknown>,
        ),
      ) as Effect.Effect<Effect.Effect<unknown, never, any>>
  },
)

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Define a Cloudflare Workflow class with an Effect-native body.
 *
 * ```ts
 * export class TinybirdSyncWorkflow extends Workflow<{ orgId: string }>()(
 *   "TinybirdSyncWorkflow",
 *   Effect.gen(function* () {
 *     // Phase 1 — shared init
 *     return Effect.gen(function* () {
 *       // Phase 2 — workflow body (durable steps)
 *       const event = yield* WorkflowEvent
 *       yield* task("sync", doSync(event.payload))
 *       yield* sleep("cooldown", "5 seconds")
 *     })
 *   }),
 * ) {}
 * ```
 *
 * Export the class as the `class_name` of a `workflows` binding in
 * wrangler.jsonc. Use `workflowHandle(name)` to resolve the binding
 * at runtime and start / inspect instances.
 */
export const Workflow = <_Self = unknown>() => {
  return <Result = unknown, InitReq = never>(
    name: string,
    impl: Effect.Effect<WorkflowBody<Result>, never, InitReq>,
  ) => {
    registerWorkflowImpl(name, impl as unknown as WorkflowImpl)
    return Bridge(name) as unknown as new (
      ctx: unknown,
      env: unknown,
    ) => { run(event: any, step: any): Promise<unknown> }
  }
}

/**
 * Resolve a workflow handle from the worker env for creating / inspecting
 * workflow instances.
 */
export const workflowHandle = (
  classOrName: { name: string } | string,
): Effect.Effect<WorkflowHandle, never, WorkerEnvironment> =>
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment
    const name = typeof classOrName === "string" ? classOrName : classOrName.name
    const binding = env[name] as any
    if (!binding || typeof binding.create !== "function") {
      return yield* Effect.die(
        new Error(
          `Worker env has no Workflow binding named '${name}'. Check wrangler.jsonc.`,
        ),
      )
    }
    return {
      name,
      create: (params?: unknown) =>
        Effect.tryPromise(() => binding.create({ params })).pipe(
          Effect.map(wrapInstance),
          Effect.orDie,
        ),
      get: (instanceId: string) =>
        Effect.tryPromise(() => binding.get(instanceId)).pipe(
          Effect.map(wrapInstance),
          Effect.orDie,
        ),
    }
  })

const wrapInstance = (raw: any): WorkflowInstance => ({
  id: raw.id,
  status: () =>
    Effect.tryPromise(() => raw.status()).pipe(
      Effect.map((s: any) => ({
        status: s.status as string,
        output: s.output,
        error: s.error,
      })),
      Effect.orDie,
    ),
  pause: () => Effect.tryPromise(() => raw.pause()).pipe(Effect.orDie),
  resume: () => Effect.tryPromise(() => raw.resume()).pipe(Effect.orDie),
  terminate: () => Effect.tryPromise(() => raw.terminate()).pipe(Effect.orDie),
})
