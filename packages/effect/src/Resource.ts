/**
 * @since 2.0.0
 */
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import { identity } from "./Function.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import type { Pipeable } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type * as Schedule from "./Schedule.ts"
import type * as Scope from "./Scope.ts"
import * as ScopedRef from "./ScopedRef.ts"
import * as ServiceMap from "./ServiceMap.ts"

const TypeId = "~effect/Resource" as const

/**
 * A `Resource` is a value loaded into memory that can be refreshed manually or
 * automatically according to a schedule.
 *
 * @since 2.0.0
 * @category models
 */
export interface Resource<in out A, in out E = never> extends Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly scopedRef: ScopedRef.ScopedRef<Exit.Exit<A, E>>
  readonly acquire: Effect.Effect<A, E>
}

/**
 * @since 2.0.0
 * @category guards
 */
export const isResource: (u: unknown) => u is Resource<unknown, unknown> = (
  u: unknown
): u is Resource<unknown, unknown> => hasProperty(u, TypeId)

const Proto = {
  ...PipeInspectableProto,
  [TypeId]: TypeId,
  toJSON() {
    return {
      _id: "Resource"
    }
  }
}

const makeUnsafe = <A, E>(
  scopedRef: ScopedRef.ScopedRef<Exit.Exit<A, E>>,
  acquire: Effect.Effect<A, E>
): Resource<A, E> => {
  const self = Object.create(Proto)
  self.scopedRef = scopedRef
  self.acquire = acquire
  return self
}

/**
 * Creates a `Resource` that must be refreshed manually.
 *
 * @since 2.0.0
 * @category constructors
 */
export const manual = <A, E, R>(
  acquire: Effect.Effect<A, E, R>
): Effect.Effect<Resource<A, E>, never, Scope.Scope | R> =>
  Effect.servicesWith((services: ServiceMap.ServiceMap<R>) => {
    const providedAcquire = Effect.updateServices(
      acquire,
      (input: ServiceMap.ServiceMap<never>) => ServiceMap.merge(services, input)
    )
    return Effect.map(
      ScopedRef.fromAcquire(Effect.exit(providedAcquire)),
      (scopedRef) => makeUnsafe(scopedRef, providedAcquire)
    )
  })

/**
 * Creates a `Resource` that refreshes automatically according to the supplied
 * schedule.
 *
 * @since 2.0.0
 * @category constructors
 */
export const auto = <A, E, R, Out, E2, R2>(
  acquire: Effect.Effect<A, E, R>,
  policy: Schedule.Schedule<Out, unknown, E2, R2>
): Effect.Effect<Resource<A, E>, never, R | R2 | Scope.Scope> =>
  Effect.tap(
    manual(acquire),
    (self) => Effect.forkScoped(Effect.repeat(refresh(self), policy))
  )

/**
 * Retrieves the current value stored in this resource.
 *
 * @since 2.0.0
 * @category getters
 */
export const get = <A, E>(self: Resource<A, E>): Effect.Effect<A, E> =>
  Effect.flatMap(ScopedRef.get(self.scopedRef), identity)

/**
 * Refreshes this resource.
 *
 * @since 2.0.0
 * @category utils
 */
export const refresh = <A, E>(self: Resource<A, E>): Effect.Effect<void, E> =>
  ScopedRef.set(self.scopedRef, Effect.map(self.acquire, Exit.succeed))
