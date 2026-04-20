/**
 * @since 4.0.0
 */
import type * as Effect from "./Effect.ts"
import type * as Fiber from "./Fiber.ts"
import { evaluate, makePrimitiveProto } from "./internal/core.ts"

/**
 * Create a low-level `Effect` prototype.
 *
 * Whe the effect is evaluated, it will call `evaluate` with the current fiber.
 *
 * @since 4.0.0
 * @category Prototypes
 */
export const Prototype = <A extends Effect.Effect<any, any, any>>(options: {
  readonly label: string
  readonly evaluate: (
    this: A,
    fiber: Fiber.Fiber<any, any>
  ) => Effect.Effect<Effect.Success<A>, Effect.Error<A>, Effect.Services<A>>
}): Effect.Effect<Effect.Success<A>, Effect.Error<A>, Effect.Services<A>> =>
  makePrimitiveProto({
    op: options.label,
    [evaluate]: options.evaluate
  }) as any

const Base: new<A, E, R>() => Effect.Effect<A, E, R> = (() => {
  const Base = function() {}
  Base.prototype = Prototype({
    label: "Effectable",
    evaluate(_) {
      return this.asEffect()
    }
  })
  return Base as any
})()

/**
 * An abstract class that can be extended to create an `Effect`.
 *
 * @since 4.0.0
 * @category Constructors
 */
export abstract class Class<A, E = never, R = never> extends Base<A, E, R> {
  abstract override asEffect(): Effect.Effect<A, E, R>
}
