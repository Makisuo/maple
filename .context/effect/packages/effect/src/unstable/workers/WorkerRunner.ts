/**
 * @since 4.0.0
 */
import type * as Effect from "../../Effect.ts"
import type * as Queue from "../../Queue.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type { WorkerError } from "./WorkerError.ts"

/**
 * @since 4.0.0
 * @category models
 */
export interface WorkerRunner<O = unknown, I = unknown> {
  readonly run: <A, E, R>(
    handler: (portId: number, message: I) => Effect.Effect<A, E, R> | void
  ) => Effect.Effect<void, WorkerError, R>
  readonly send: (
    portId: number,
    message: O,
    transfers?: ReadonlyArray<unknown>
  ) => Effect.Effect<void>
  readonly sendUnsafe: (
    portId: number,
    message: O,
    transfers?: ReadonlyArray<unknown>
  ) => void
  readonly disconnects?: Queue.Dequeue<number> | undefined
}

/**
 * @since 4.0.0
 * @category models
 */
export type PlatformMessage<I> = readonly [request: 0, I] | readonly [close: 1]

/**
 * @since 4.0.0
 * @category models
 */
export class WorkerRunnerPlatform extends ServiceMap.Service<WorkerRunnerPlatform, {
  readonly start: <O = unknown, I = unknown>() => Effect.Effect<WorkerRunner<O, I>, WorkerError>
}>()("effect/workers/WorkerRunner/WorkerRunnerPlatform") {}
