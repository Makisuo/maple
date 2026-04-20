/**
 * @since 1.0.0
 */
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Channel from "effect/Channel"
import * as Effect from "effect/Effect"
import type { LazyArg } from "effect/Function"
import type * as Pull from "effect/Pull"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

/**
 * @since 1.0.0
 */
export * from "@effect/platform-node-shared/NodeStream"

/**
 * An optimized version of `Stream.fromReadableStream` that uses the Bun
 * .readMany API to read multiple values at once from a `ReadableStream`.
 *
 * @since 1.0.0
 */
export const fromReadableStream = <A, E>(
  options: {
    readonly evaluate: LazyArg<ReadableStream<A>>
    readonly onError: (error: unknown) => E
    readonly releaseLockOnEnd?: boolean | undefined
  }
): Stream.Stream<A, E> =>
  Stream.fromChannel(Channel.fromTransform(Effect.fnUntraced(function*(_, scope) {
    const reader = options.evaluate().getReader()
    yield* Scope.addFinalizer(
      scope,
      options.releaseLockOnEnd ? Effect.sync(() => reader.releaseLock()) : Effect.promise(() => reader.cancel())
    )
    const readMany = Effect.callback<Bun.ReadableStreamDefaultReadManyResult<A>, E>((resume) => {
      const result = reader.readMany()
      if ("then" in result) {
        result.then((_) => resume(Effect.succeed(_)), (e) => resume(Effect.fail(options.onError(e))))
      } else {
        resume(Effect.succeed(result))
      }
    })
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.flatMap(
      readMany,
      function loop(
        { done, value }
      ): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E> {
        if (done) {
          return Cause.done()
        } else if (!Arr.isReadonlyArrayNonEmpty(value)) {
          return Effect.flatMap(readMany, loop)
        }
        return Effect.succeed(value)
      }
    )
  })))
