/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import type { Scope } from "../../Scope.ts"
import { Sharding } from "./Sharding.ts"

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = <E, R>(
  name: string,
  run: Effect.Effect<void, E, R>,
  options?: {
    readonly shardGroup?: string | undefined
  }
): Layer.Layer<never, never, Sharding | Exclude<R, Scope>> =>
  Layer.effectDiscard(Effect.gen(function*() {
    const sharding = yield* Sharding
    yield* sharding.registerSingleton(name, run, options)
  }))
