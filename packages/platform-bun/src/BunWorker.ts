/**
 * @since 1.0.0
 */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Worker from "effect/unstable/workers/Worker"
import { WorkerError, WorkerUnknownError } from "effect/unstable/workers/WorkerError"

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = (
  spawn: (id: number) => globalThis.Worker
): Layer.Layer<Worker.WorkerPlatform | Worker.Spawner> =>
  Layer.merge(
    layerPlatform,
    Layer.succeed(Worker.Spawner)(spawn)
  )

/**
 * @since 1.0.0
 * @category layers
 */
export const layerPlatform = Layer.succeed(Worker.WorkerPlatform)(
  Worker.makePlatform<globalThis.Worker>()({
    setup({ scope, worker }) {
      const closeDeferred = Deferred.makeUnsafe<void>()
      worker.addEventListener("close", () => {
        Deferred.doneUnsafe(closeDeferred, Exit.void)
      })
      return Effect.as(
        Scope.addFinalizer(
          scope,
          Effect.suspend(() => {
            worker.postMessage([1])
            return Deferred.await(closeDeferred)
          }).pipe(
            Effect.interruptible,
            Effect.timeout(5000),
            Effect.catchCause(() => Effect.sync(() => worker.terminate()))
          )
        ),
        worker
      )
    },
    listen({ deferred, emit, port, scope }) {
      function onMessage(event: MessageEvent) {
        emit(event.data)
      }
      function onError(event: ErrorEvent) {
        Deferred.doneUnsafe(
          deferred,
          new WorkerError({
            reason: new WorkerUnknownError({
              message: "An error event was emitted",
              cause: event.error ?? event.message
            })
          }).asEffect()
        )
      }
      port.addEventListener("message", onMessage)
      port.addEventListener("error", onError)
      return Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          port.removeEventListener("message", onMessage)
          port.removeEventListener("error", onError)
        })
      )
    }
  })
)
