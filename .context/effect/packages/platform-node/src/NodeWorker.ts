/**
 * @since 1.0.0
 */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Worker from "effect/unstable/workers/Worker"
import { WorkerError, WorkerReceiveError } from "effect/unstable/workers/WorkerError"
import type * as ChildProcess from "node:child_process"
import type * as WorkerThreads from "node:worker_threads"

/**
 * @since 1.0.0
 * @category layers
 */
export const layerPlatform: Layer.Layer<Worker.WorkerPlatform> = Layer.succeed(Worker.WorkerPlatform)(
  Worker.makePlatform<WorkerThreads.Worker | ChildProcess.ChildProcess>()({
    setup({ scope, worker }) {
      const exitDeferred = Deferred.makeUnsafe<void, WorkerError>()
      const thing = "postMessage" in worker ?
        {
          postMessage(msg: any, t?: any) {
            worker.postMessage(msg, t)
          },
          kill: () => worker.terminate(),
          worker
        } :
        {
          postMessage(msg: any, _?: any) {
            worker.send(msg)
          },
          kill: () => worker.kill("SIGKILL"),
          worker
        }
      worker.on("exit", () => {
        Deferred.doneUnsafe(exitDeferred, Exit.void)
      })
      return Effect.as(
        Scope.addFinalizer(
          scope,
          Effect.suspend(() => {
            thing.postMessage([1])
            return Deferred.await(exitDeferred)
          }).pipe(
            Effect.timeout(5000),
            Effect.catchCause(() => Effect.sync(() => thing.kill()))
          )
        ),
        thing
      )
    },
    listen({ deferred, emit, port }) {
      port.worker.on("message", (message) => {
        emit(message)
      })
      port.worker.on("messageerror", (cause) => {
        Deferred.doneUnsafe(
          deferred,
          new WorkerError({
            reason: new WorkerReceiveError({
              message: "An messageerror event was emitted",
              cause
            })
          }).asEffect()
        )
      })
      port.worker.on("error", (cause) => {
        Deferred.doneUnsafe(
          deferred,
          new WorkerError({
            reason: new WorkerReceiveError({
              message: "An error event was emitted",
              cause
            })
          }).asEffect()
        )
      })
      port.worker.on("exit", (code) => {
        Deferred.doneUnsafe(
          deferred,
          new WorkerError({
            reason: new WorkerReceiveError({
              message: "The worker has exited with code: " + code
            })
          }).asEffect()
        )
      })
      return Effect.void
    }
  })
)

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = (
  spawn: (id: number) => WorkerThreads.Worker | ChildProcess.ChildProcess
): Layer.Layer<Worker.WorkerPlatform | Worker.Spawner> =>
  Layer.merge(
    Worker.layerSpawner(spawn),
    layerPlatform
  )
