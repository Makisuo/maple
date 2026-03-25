/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Semaphore from "../../Semaphore.ts"
import type * as ServiceMap from "../../ServiceMap.ts"

/**
 * @since 4.0.0
 */
export const withRun = <
  A extends {
    readonly run: (f: (...args: Array<any>) => Effect.Effect<void>) => Effect.Effect<never>
  }
>() =>
<EX, RX>(f: (write: Parameters<A["run"]>[0]) => Effect.Effect<Omit<A, "run">, EX, RX>): Effect.Effect<A, EX, RX> =>
  Effect.suspend(() => {
    const semaphore = Semaphore.makeUnsafe(1)
    let buffer: Array<[Array<any>, ServiceMap.ServiceMap<never>]> = []
    let write = (...args: Array<any>): Effect.Effect<void> =>
      Effect.servicesWith((context) => {
        buffer.push([args, context])
        return Effect.void
      })
    return Effect.map(f((...args) => write(...args)), (a) => ({
      ...a,
      run(f) {
        return semaphore.withPermits(1)(Effect.gen(function*() {
          const prev = write
          write = f

          for (const [args, context] of buffer) {
            yield* Effect.provideServices(Effect.suspend(() => f(...args)), context)
          }
          buffer = []

          return yield* Effect.onExit(Effect.never, () => {
            write = prev
            return Effect.void
          })
        }))
      }
    } as A))
  })
