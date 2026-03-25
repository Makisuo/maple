/**
 * @since 2.0.0
 */
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import { dual, type LazyArg } from "./Function.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import type { Pipeable } from "./Pipeable.ts"
import * as Scope from "./Scope.ts"
import * as Synchronized from "./SynchronizedRef.ts"

const TypeId = "~effect/ScopedRef"

/**
 * A `ScopedRef` is a reference whose value is associated with resources,
 * which must be released properly. You can both get the current value of any
 * `ScopedRef`, as well as set it to a new value (which may require new
 * resources). The reference itself takes care of properly releasing resources
 * for the old value whenever a new value is obtained.
 *
 * @since 2.0.0
 * @category models
 */
export interface ScopedRef<in out A> extends Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly backing: Synchronized.SynchronizedRef<readonly [Scope.Closeable, A]>
}

const Proto = {
  ...PipeInspectableProto,
  [TypeId]: TypeId,
  toJSON(this: ScopedRef<any>) {
    return {
      _id: "ScopedRef",
      value: this.backing.backing.ref.current[1]
    }
  }
}

const makeUnsafe = <A>(
  scope: Scope.Closeable,
  value: A
): ScopedRef<A> => {
  const self = Object.create(Proto)
  self.backing = Synchronized.makeUnsafe([scope, value] as const)
  return self
}

/**
 * Creates a new `ScopedRef` from an effect that resourcefully produces a
 * value.
 *
 * @since 2.0.0
 * @category constructors
 */
export const fromAcquire: <A, E, R>(
  acquire: Effect.Effect<A, E, R>
) => Effect.Effect<ScopedRef<A>, E, Scope.Scope | R> = Effect.fnUntraced(function*<A, E, R>(
  acquire: Effect.Effect<A, E, R>
) {
  const scope = Scope.makeUnsafe()
  const value = yield* acquire.pipe(
    Scope.provide(scope),
    Effect.tapCause((cause) => Scope.close(scope, Exit.failCause(cause)))
  )
  const self = makeUnsafe(scope, value)
  yield* Effect.addFinalizer((exit) => Scope.close(self.backing.backing.ref.current[0], exit))
  return self
}, Effect.uninterruptible)

/**
 * Retrieves the current value of the scoped reference.
 *
 * @since 4.0.0
 * @category getters
 */
export const getUnsafe = <A>(self: ScopedRef<A>): A => self.backing.backing.ref.current[1]

/**
 * Retrieves the current value of the scoped reference.
 *
 * @since 2.0.0
 * @category getters
 */
export const get = <A>(self: ScopedRef<A>): Effect.Effect<A> => Effect.sync(() => getUnsafe(self))

/**
 * Creates a new `ScopedRef` from the specified value. This method should
 * not be used for values whose creation require the acquisition of resources.
 *
 * @since 2.0.0
 * @category constructors
 */
export const make = <A>(evaluate: LazyArg<A>): Effect.Effect<ScopedRef<A>, never, Scope.Scope> =>
  Effect.suspend(() => {
    const scope = Scope.makeUnsafe()
    const value = evaluate()
    const self = makeUnsafe(scope, value)
    return Effect.as(Effect.addFinalizer((exit) => Scope.close(self.backing.backing.ref.current[0], exit)), self)
  })

/**
 * Sets the value of this reference to the specified resourcefully-created
 * value. Any resources associated with the old value will be released.
 *
 * This method will not return until either the reference is successfully
 * changed to the new value, with old resources released, or until the attempt
 * to acquire a new value fails.
 *
 * @since 2.0.0
 * @category getters
 */
export const set: {
  <A, R, E>(acquire: Effect.Effect<A, E, R>): (self: ScopedRef<A>) => Effect.Effect<void, E, Exclude<R, Scope.Scope>>
  <A, R, E>(self: ScopedRef<A>, acquire: Effect.Effect<A, E, R>): Effect.Effect<void, E, Exclude<R, Scope.Scope>>
} = dual(
  2,
  Effect.fnUntraced(
    function*<A, R, E>(
      self: ScopedRef<A>,
      acquire: Effect.Effect<A, E, R>
    ) {
      yield* Scope.close(self.backing.backing.ref.current[0], Exit.void)
      const scope = Scope.makeUnsafe()
      const value = yield* acquire.pipe(
        Scope.provide(scope),
        Effect.tapCause((cause) => Scope.close(scope, Exit.failCause(cause)))
      )
      self.backing.backing.ref.current = [scope, value]
    },
    Effect.uninterruptible,
    (effect, self) => self.backing.semaphore.withPermit(effect)
  )
)
