/**
 * This module provides a data structure called `Context` that can be used
 * for dependency injection in effectful programs. It is essentially a table
 * mapping `Service`s identifiers to their implementations, and can be used to
 * manage dependencies in a type-safe way. The `Context` data structure is
 * essentially a way of providing access to a set of related services that can
 * be passed around as a single unit. This module provides functions to create,
 * modify, and query the contents of a `Context`, as well as a number of
 * utility types for working with a `Context`.
 *
 * @since 4.0.0
 */
import type { Effect, EffectIterator, Yieldable } from "./Effect.ts"
import * as Equal from "./Equal.ts"
import { constant, dual, type LazyArg } from "./Function.ts"
import * as Hash from "./Hash.ts"
import type { Inspectable } from "./Inspectable.ts"
import { exitSucceed, PipeInspectableProto, withFiber, YieldableProto } from "./internal/core.ts"
import type { ErrorWithStackTraceLimit } from "./internal/tracer.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type * as Types from "./Types.ts"

/**
 * @since 4.0.0
 * @category Type Identifiers
 */
export type ServiceTypeId = "~effect/Context/Service"

/**
 * @since 4.0.0
 * @category Type Identifiers
 */
export const ServiceTypeId: ServiceTypeId = "~effect/Context/Service"

/**
 * The base type used for all Context keys.
 *
 * @since 4.0.0
 * @category Models
 */
export interface Key<out Identifier, out Shape> extends Pipeable, Inspectable {
  readonly [ServiceTypeId]: ServiceTypeId
  readonly Service: Shape
  readonly Identifier: Identifier
  readonly key: string
  readonly stack?: string | undefined
  asEffect(): Effect<Shape, never, Identifier>
}

/**
 * @example
 * ```ts
 * import { Context } from "effect"
 *
 * // Define an identifier for a database service
 * const Database = Context.Service<{ query: (sql: string) => string }>(
 *   "Database"
 * )
 *
 * // The key can be used to store and retrieve services
 * const context = Context.make(Database, { query: (sql) => `Result: ${sql}` })
 * ```
 *
 * @since 4.0.0
 * @category Models
 */
export interface Service<in out Identifier, in out Shape>
  extends Key<Identifier, Shape>, Yieldable<Service<Identifier, Shape>, Shape, never, Identifier>
{
  of(this: void, self: Shape): Shape
  context(self: Shape): Context<Identifier>
  use<A, E, R>(f: (service: Shape) => Effect<A, E, R>): Effect<A, E, R | Identifier>
  useSync<A>(f: (service: Shape) => A): Effect<A, never, Identifier>
}

/**
 * @since 4.0.0
 * @category Models
 */
export interface ServiceClass<in out Self, in out Identifier extends string, in out Shape>
  extends Service<Self, Shape>
{
  new(_: never): ServiceClass.Shape<Identifier, Shape>
  readonly key: Identifier
}

/**
 * @since 4.0.0
 * @category Models
 */
export declare namespace ServiceClass {
  /**
   * @since 4.0.0
   * @category Models
   */
  export interface Shape<Identifier extends string, Service> {
    readonly [ServiceTypeId]: typeof ServiceTypeId
    readonly key: Identifier
    readonly Service: Service
  }
}

/**
 * @example
 * ```ts
 * import { Context } from "effect"
 *
 * // Create a simple service
 * const Database = Context.Service<{
 *   query: (sql: string) => string
 * }>("Database")
 *
 * // Create a service class
 * class Config extends Context.Service<Config, {
 *   port: number
 * }>()("Config") {}
 *
 * // Use the services to create contexts
 * const db = Context.make(Database, {
 *   query: (sql) => `Result: ${sql}`
 * })
 * const config = Context.make(Config, { port: 8080 })
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const Service: {
  <Identifier, Shape = Identifier>(key: string): Service<Identifier, Shape>
  <Self, Shape>(): <
    const Identifier extends string,
    E,
    R = Types.unassigned,
    Args extends ReadonlyArray<any> = never
  >(
    id: Identifier,
    options?: {
      readonly make: ((...args: Args) => Effect<Shape, E, R>) | Effect<Shape, E, R> | undefined
    } | undefined
  ) =>
    & ServiceClass<Self, Identifier, Shape>
    & ([Types.unassigned] extends [R] ? unknown
      : { readonly make: [Args] extends [never] ? Effect<Shape, E, R> : (...args: Args) => Effect<Shape, E, R> })
  <Self>(): <
    const Identifier extends string,
    Make extends Effect<any, any, any> | ((...args: any) => Effect<any, any, any>)
  >(
    id: Identifier,
    options: {
      readonly make: Make
    }
  ) =>
    & ServiceClass<
      Self,
      Identifier,
      Make extends
        Effect<infer _A, infer _E, infer _R> | ((...args: infer _Args) => Effect<infer _A, infer _E, infer _R>) ? _A
        : never
    >
    & { readonly make: Make }
} = function() {
  const prevLimit = (Error as ErrorWithStackTraceLimit).stackTraceLimit
  ;(Error as ErrorWithStackTraceLimit)
    .stackTraceLimit = 2
  const err = new Error()
  ;(Error as ErrorWithStackTraceLimit).stackTraceLimit = prevLimit
  function KeyClass() {}
  const self = KeyClass as any as Types.Mutable<Reference<any>>
  Object.setPrototypeOf(self, ServiceProto)
  Object.defineProperty(self, "stack", {
    get() {
      return err.stack
    }
  })
  if (arguments.length > 0) {
    self.key = arguments[0]
    if (arguments[1]?.defaultValue) {
      self[ReferenceTypeId] = ReferenceTypeId
      self.defaultValue = arguments[1].defaultValue
    }
    return self
  }
  return function(key: string, options?: {
    readonly make?: any
  }) {
    self.key = key
    if (options?.make) {
      ;(self as any).make = options.make
    }
    return self
  }
} as any

const ServiceProto: any = {
  [ServiceTypeId]: ServiceTypeId,
  ...PipeInspectableProto,
  ...YieldableProto,
  toJSON<I, A>(this: Service<I, A>) {
    return {
      _id: "Service",
      key: this.key,
      stack: this.stack
    }
  },
  asEffect(this: any) {
    const fn = this.asEffect = constant(withFiber((fiber) => exitSucceed(get(fiber.context, this))))
    return fn()
  },
  of<Service>(this: void, self: Service): Service {
    return self
  },
  context<Identifier, Shape>(
    this: Service<Identifier, Shape>,
    self: Shape
  ): Context<Identifier> {
    return make(this, self)
  },
  use<A, E, R>(this: Service<never, any>, f: (service: any) => Effect<A, E, R>): Effect<A, E, R> {
    return withFiber((fiber) => f(get(fiber.context, this)))
  },
  useSync<A>(this: Service<never, any>, f: (service: any) => A): Effect<A, never, never> {
    return withFiber((fiber) => exitSucceed(f(get(fiber.context, this))))
  }
}

const ReferenceTypeId = "~effect/Context/Reference" as const

/**
 * @example
 * ```ts
 * import { Context } from "effect"
 *
 * // Define a reference with a default value
 * const LoggerRef: Context.Reference<{ log: (msg: string) => void }> =
 *   Context.Reference("Logger", {
 *     defaultValue: () => ({ log: (msg: string) => console.log(msg) })
 *   })
 *
 * // The reference can be used without explicit provision
 * const context = Context.empty()
 * const logger = Context.get(context, LoggerRef) // Uses default value
 * ```
 *
 * @since 4.0.0
 * @category Models
 */
export interface Reference<in out Shape> extends Service<never, Shape> {
  readonly [ReferenceTypeId]: typeof ReferenceTypeId
  readonly defaultValue: () => Shape
  [Symbol.iterator](): EffectIterator<Reference<Shape>>
  new(_: never): {}
}

/**
 * @example
 * ```ts
 * import { Context } from "effect"
 *
 * const Database = Context.Service<{
 *   query: (sql: string) => string
 * }>("Database")
 *
 * // Extract service type from a key
 * type DatabaseService = Context.Service.Shape<typeof Database>
 *
 * // Extract identifier type from a key
 * type DatabaseId = Context.Service.Identifier<typeof Database>
 * ```
 *
 * @since 4.0.0
 * @category Models
 */
export declare namespace Service {
  /**
   * @example
   * ```ts
   * import { Context } from "effect"
   *
   * // Any represents any possible service type
   * const services: Array<Context.Service.Any> = [
   *   Context.Service<{ log: (msg: string) => void }>("Logger"),
   *   Context.Service<{ query: (sql: string) => string }>("Database")
   * ]
   * ```
   *
   * @since 4.0.0
   * @category Models
   */
  export type Any = Key<never, any> | Key<any, any>

  /**
   * @example
   * ```ts
   * import { Context } from "effect"
   *
   * const Database = Context.Service<{ query: (sql: string) => string }>(
   *   "Database"
   * )
   *
   * // Extract the service shape from the service
   * type DatabaseService = Context.Service.Shape<typeof Database>
   * // DatabaseService is { query: (sql: string) => string }
   * ```
   *
   * @since 4.0.0
   * @category Models
   */
  export type Shape<T> = T extends Key<infer _I, infer S> ? S : never

  /**
   * @example
   * ```ts
   * import { Context } from "effect"
   *
   * const Database = Context.Service<{ query: (sql: string) => string }>(
   *   "Database"
   * )
   *
   * // Extract the identifier type from a key
   * type DatabaseId = Context.Service.Identifier<typeof Database>
   * // DatabaseId is the identifier type
   * ```
   *
   * @since 4.0.0
   * @category Models
   */
  export type Identifier<T> = T extends Key<infer I, infer _S> ? I : never
}

const TypeId = "~effect/Context" as const

/**
 * @example
 * ```ts
 * import { Context } from "effect"
 *
 * // Create a context with multiple services
 * const Logger = Context.Service<{ log: (msg: string) => void }>("Logger")
 * const Database = Context.Service<{ query: (sql: string) => string }>(
 *   "Database"
 * )
 *
 * const context = Context.make(Logger, {
 *   log: (msg: string) => console.log(msg)
 * })
 *   .pipe(Context.add(Database, { query: (sql) => `Result: ${sql}` }))
 * ```
 *
 * @since 4.0.0
 * @category Models
 */
export interface Context<in Services> extends Equal.Equal, Pipeable, Inspectable {
  readonly [TypeId]: {
    readonly _Services: Types.Contravariant<Services>
  }
  readonly mapUnsafe: ReadonlyMap<string, any>
  mutable: boolean
}

/**
 * @example
 * ```ts
 * import { Context } from "effect"
 *
 * // Create a context from a Map (unsafe)
 * const map = new Map([
 *   ["Logger", { log: (msg: string) => console.log(msg) }]
 * ])
 *
 * const context = Context.makeUnsafe(map)
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const makeUnsafe = <Services = never>(mapUnsafe: ReadonlyMap<string, any>): Context<Services> => {
  const self = Object.create(Proto)
  self.mapUnsafe = mapUnsafe
  self.mutable = false
  return self
}

const Proto: Omit<Context<never>, "mapUnsafe" | "mutable"> = {
  ...PipeInspectableProto,
  [TypeId]: {
    _Services: (_: never) => _
  },
  toJSON(this: Context<never>) {
    return {
      _id: "Context",
      services: Array.from(this.mapUnsafe).map(([key, value]) => ({ key, value }))
    }
  },
  [Equal.symbol]<A>(this: Context<A>, that: unknown): boolean {
    if (
      !isContext(that)
      || this.mapUnsafe.size !== that.mapUnsafe.size
    ) return false
    for (const k of this.mapUnsafe.keys()) {
      if (
        !that.mapUnsafe.has(k) ||
        !Equal.equals(this.mapUnsafe.get(k), that.mapUnsafe.get(k))
      ) {
        return false
      }
    }
    return true
  },
  [Hash.symbol]<A>(this: Context<A>): number {
    return Hash.number(this.mapUnsafe.size)
  }
}

/**
 * Checks if the provided argument is a `Context`.
 *
 * @example
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.strictEqual(Context.isContext(Context.empty()), true)
 * ```
 *
 * @since 4.0.0
 * @category Guards
 */
export const isContext = (u: unknown): u is Context<never> => hasProperty(u, TypeId)

/**
 * Checks if the provided argument is a `Key`.
 *
 * @example
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.strictEqual(Context.isKey(Context.Service("Service")), true)
 * ```
 *
 * @since 4.0.0
 * @category Guards
 */
export const isKey = (u: unknown): u is Key<any, any> => hasProperty(u, ServiceTypeId)

/**
 * Checks if the provided argument is a `Reference`.
 *
 * @example
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const LoggerRef = Context.Reference("Logger", {
 *   defaultValue: () => ({ log: (msg: string) => console.log(msg) })
 * })
 *
 * assert.strictEqual(Context.isReference(LoggerRef), true)
 * assert.strictEqual(Context.isReference(Context.Service("Key")), false)
 * ```
 *
 * @since 4.0.0
 * @category Guards
 */
export const isReference = (u: unknown): u is Reference<any> => hasProperty(u, ReferenceTypeId)

/**
 * Returns an empty `Context`.
 *
 * @example
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.strictEqual(Context.isContext(Context.empty()), true)
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const empty = (): Context<never> => emptyContext
const emptyContext = makeUnsafe(new Map())

/**
 * Creates a new `Context` with a single service associated to the key.
 *
 * @example
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 *
 * const context = Context.make(Port, { PORT: 8080 })
 *
 * assert.deepStrictEqual(Context.get(context, Port), { PORT: 8080 })
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const make = <I, S>(
  key: Key<I, S>,
  service: Types.NoInfer<S>
): Context<I> => makeUnsafe(new Map([[key.key, service]]))

/**
 * Adds a service to a given `Context`.
 *
 * @example
 * ```ts
 * import { pipe, Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const someContext = Context.make(Port, { PORT: 8080 })
 *
 * const context = pipe(
 *   someContext,
 *   Context.add(Timeout, { TIMEOUT: 5000 })
 * )
 *
 * assert.deepStrictEqual(Context.get(context, Port), { PORT: 8080 })
 * assert.deepStrictEqual(Context.get(context, Timeout), { TIMEOUT: 5000 })
 * ```
 *
 * @since 4.0.0
 * @category Adders
 */
export const add: {
  <I, S>(
    key: Key<I, S>,
    service: Types.NoInfer<S>
  ): <Services>(self: Context<Services>) => Context<Services | I>
  <Services, I, S>(
    self: Context<Services>,
    key: Key<I, S>,
    service: Types.NoInfer<S>
  ): Context<Services | I>
} = dual(3, <Services, I, S>(
  self: Context<Services>,
  key: Key<I, S>,
  service: Types.NoInfer<S>
): Context<Services | I> =>
  withMapUnsafe(self, (map) => {
    map.set(key.key, service)
  }))

/**
 * @since 4.0.0
 * @category Adders
 */
export const addOrOmit: {
  <I, S>(
    key: Key<I, S>,
    service: Option.Option<Types.NoInfer<S>>
  ): <Services>(self: Context<Services>) => Context<Services | I>
  <Services, I, S>(
    self: Context<Services>,
    key: Key<I, S>,
    service: Option.Option<Types.NoInfer<S>>
  ): Context<Services | I>
} = dual(3, <Services, I, S>(
  self: Context<Services>,
  key: Key<I, S>,
  service: Option.Option<Types.NoInfer<S>>
): Context<Services | I> =>
  withMapUnsafe(self, (map) => {
    if (service._tag === "None") {
      map.delete(key.key)
    } else {
      map.set(key.key, service.value)
    }
  }))

/**
 * Get a service from the context that corresponds to the given key, or
 * use the fallback value.
 *
 * @example
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Logger = Context.Service<{ log: (msg: string) => void }>("Logger")
 * const Database = Context.Service<{ query: (sql: string) => string }>(
 *   "Database"
 * )
 *
 * const context = Context.make(Logger, {
 *   log: (msg: string) => console.log(msg)
 * })
 *
 * const logger = Context.getOrElse(context, Logger, () => ({ log: () => {} }))
 * const database = Context.getOrElse(
 *   context,
 *   Database,
 *   () => ({ query: () => "fallback" })
 * )
 *
 * assert.deepStrictEqual(logger, { log: (msg: string) => console.log(msg) })
 * assert.deepStrictEqual(database, { query: () => "fallback" })
 * ```
 *
 * @since 4.0.0
 * @category Getters
 */
export const getOrElse: {
  <S, I, B>(key: Key<I, S>, orElse: LazyArg<B>): <Services>(self: Context<Services>) => S | B
  <Services, S, I, B>(self: Context<Services>, key: Key<I, S>, orElse: LazyArg<B>): S | B
} = dual(3, <Services, S, I, B>(self: Context<Services>, key: Key<I, S>, orElse: LazyArg<B>): S | B => {
  if (self.mapUnsafe.has(key.key)) {
    return self.mapUnsafe.get(key.key)! as any
  }
  return isReference(key) ? getDefaultValue(key) : orElse()
})

/**
 * @since 4.0.0
 * @category Getters
 */
export const getOrUndefined: {
  <S, I>(key: Key<I, S>): <Services>(self: Context<Services>) => S | undefined
  <Services, S, I>(self: Context<Services>, key: Key<I, S>): S | undefined
} = dual(
  2,
  <Services, S, I>(self: Context<Services>, key: Key<I, S>): S | undefined => self.mapUnsafe.get(key.key)
)

/**
 * Get a service from the context that corresponds to the given key.
 *
 * This function is unsafe because if the key is not present in the context, a
 * runtime error will be thrown.
 *
 * For a safer version see {@link getOption}.
 *
 * @param self - The `Context` to search for the service.
 * @param service - The `Service` of the service to retrieve.
 *
 * @example
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const context = Context.make(Port, { PORT: 8080 })
 *
 * assert.deepStrictEqual(Context.getUnsafe(context, Port), { PORT: 8080 })
 * assert.throws(() => Context.getUnsafe(context, Timeout))
 * ```
 *
 * @since 4.0.0
 * @category unsafe
 */
export const getUnsafe: {
  <S, I>(service: Key<I, S>): <Services>(self: Context<Services>) => S
  <Services, S, I>(self: Context<Services>, services: Key<I, S>): S
} = dual(
  2,
  <Services, I extends Services, S>(self: Context<Services>, service: Key<I, S>): S => {
    if (!self.mapUnsafe.has(service.key)) {
      if (ReferenceTypeId in service) return getDefaultValue(service as any)
      throw serviceNotFoundError(service)
    }
    return self.mapUnsafe.get(service.key)! as any
  }
)

/**
 * Get a service from the context that corresponds to the given key.
 *
 * @param self - The `Context` to search for the service.
 * @param service - The `Service` of the service to retrieve.
 *
 * @example
 * ```ts
 * import { pipe, Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const context = pipe(
 *   Context.make(Port, { PORT: 8080 }),
 *   Context.add(Timeout, { TIMEOUT: 5000 })
 * )
 *
 * assert.deepStrictEqual(Context.get(context, Timeout), { TIMEOUT: 5000 })
 * ```
 *
 * @since 4.0.0
 * @category Getters
 */
export const get: {
  <Services, I extends Services, S>(service: Key<I, S>): (self: Context<Services>) => S
  <Services, I extends Services, S>(self: Context<Services>, service: Key<I, S>): S
} = getUnsafe

/**
 * @example
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const LoggerRef = Context.Reference("Logger", {
 *   defaultValue: () => ({ log: (msg: string) => console.log(msg) })
 * })
 *
 * const context = Context.empty()
 * const logger = Context.getReferenceUnsafe(context, LoggerRef)
 *
 * assert.deepStrictEqual(logger, { log: (msg: string) => console.log(msg) })
 * ```
 *
 * @since 4.0.0
 * @category unsafe
 */
export const getReferenceUnsafe = <Services, S>(self: Context<Services>, service: Reference<S>): S => {
  if (!self.mapUnsafe.has(service.key)) {
    return getDefaultValue(service as any)
  }
  return self.mapUnsafe.get(service.key)! as any
}

const defaultValueCacheKey = "~effect/Context/defaultValue" as const

const getDefaultValue = (ref: Reference<any>) => {
  if (defaultValueCacheKey in ref) {
    return ref[defaultValueCacheKey] as any
  }
  return (ref as any)[defaultValueCacheKey] = ref.defaultValue()
}

const serviceNotFoundError = (service: Key<any, any>) => {
  const error = new Error(
    `Service not found${service.key ? `: ${String(service.key)}` : ""}`
  )
  if (service.stack) {
    const lines = service.stack.split("\n")
    if (lines.length > 2) {
      const afterAt = lines[2].match(/at (.*)/)
      if (afterAt) {
        error.message = error.message + ` (defined at ${afterAt[1]})`
      }
    }
  }
  if (error.stack) {
    const lines = error.stack.split("\n")
    lines.splice(1, 3)
    error.stack = lines.join("\n")
  }
  return error
}

/**
 * Get the value associated with the specified key from the context wrapped in
 * an `Option` object. If the key is not found, the `Option` object will be
 * `None`.
 *
 * @param self - The `Context` to search for the service.
 * @param service - The `Service` of the service to retrieve.
 *
 * @example
 * ```ts
 * import { Option, Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const context = Context.make(Port, { PORT: 8080 })
 *
 * assert.deepStrictEqual(
 *   Context.getOption(context, Port),
 *   Option.some({ PORT: 8080 })
 * )
 * assert.deepStrictEqual(Context.getOption(context, Timeout), Option.none())
 * ```
 *
 * @since 4.0.0
 * @category Getters
 */
export const getOption: {
  <S, I>(service: Key<I, S>): <Services>(self: Context<Services>) => Option.Option<S>
  <Services, S, I>(self: Context<Services>, service: Key<I, S>): Option.Option<S>
} = dual(2, <Services, I extends Services, S>(self: Context<Services>, service: Key<I, S>): Option.Option<S> => {
  if (self.mapUnsafe.has(service.key)) {
    return Option.some(self.mapUnsafe.get(service.key)! as any)
  }
  return isReference(service) ? Option.some(getDefaultValue(service as any)) : Option.none()
})

/**
 * Merges two `Context`s, returning a new `Context` containing the services of both.
 *
 * @param self - The first `Context` to merge.
 * @param that - The second `Context` to merge.
 *
 * @example
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const firstContext = Context.make(Port, { PORT: 8080 })
 * const secondContext = Context.make(Timeout, { TIMEOUT: 5000 })
 *
 * const context = Context.merge(firstContext, secondContext)
 *
 * assert.deepStrictEqual(Context.get(context, Port), { PORT: 8080 })
 * assert.deepStrictEqual(Context.get(context, Timeout), { TIMEOUT: 5000 })
 * ```
 *
 * @since 4.0.0
 * @category Utils
 */
export const merge: {
  <R1>(that: Context<R1>): <Services>(self: Context<Services>) => Context<R1 | Services>
  <Services, R1>(self: Context<Services>, that: Context<R1>): Context<Services | R1>
} = dual(2, <Services, R1>(self: Context<Services>, that: Context<R1>): Context<Services | R1> => {
  if (self.mapUnsafe.size === 0) return that as any
  if (that.mapUnsafe.size === 0) return self as any
  return withMapUnsafe(self, (map) => {
    that.mapUnsafe.forEach((value, key) => map.set(key, value))
  })
})

/**
 * Merges any number of `Context`s, returning a new `Context` containing the services of all.
 *
 * @example
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 * const Host = Context.Service<{ HOST: string }>("Host")
 *
 * const firstContext = Context.make(Port, { PORT: 8080 })
 * const secondContext = Context.make(Timeout, { TIMEOUT: 5000 })
 * const thirdContext = Context.make(Host, { HOST: "localhost" })
 *
 * const context = Context.mergeAll(
 *   firstContext,
 *   secondContext,
 *   thirdContext
 * )
 *
 * assert.deepStrictEqual(Context.get(context, Port), { PORT: 8080 })
 * assert.deepStrictEqual(Context.get(context, Timeout), { TIMEOUT: 5000 })
 * assert.deepStrictEqual(Context.get(context, Host), { HOST: "localhost" })
 * ```
 *
 * @since 3.12.0
 */
export const mergeAll = <T extends Array<unknown>>(
  ...ctxs: [...{ [K in keyof T]: Context<T[K]> }]
): Context<T[number]> => {
  const map = new Map()
  for (let i = 0; i < ctxs.length; i++) {
    ctxs[i].mapUnsafe.forEach((value, key) => {
      map.set(key, value)
    })
  }
  return makeUnsafe(map)
}

/**
 * Returns a new `Context` that contains only the specified services.
 *
 * @param self - The `Context` to prune services from.
 * @param services - The list of `Service`s to be included in the new `Context`.
 *
 * @example
 * ```ts
 * import { Option, pipe, Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const someContext = pipe(
 *   Context.make(Port, { PORT: 8080 }),
 *   Context.add(Timeout, { TIMEOUT: 5000 })
 * )
 *
 * const context = pipe(someContext, Context.pick(Port))
 *
 * assert.deepStrictEqual(
 *   Context.getOption(context, Port),
 *   Option.some({ PORT: 8080 })
 * )
 * assert.deepStrictEqual(Context.getOption(context, Timeout), Option.none())
 * ```
 *
 * @since 4.0.0
 * @category Utils
 */
export const pick = <S extends ReadonlyArray<Key<any, any>>>(
  ...services: S
) =>
<Services>(self: Context<Services>): Context<Services & Service.Identifier<S[number]>> =>
  withMapUnsafe(self, (map) => {
    const keySet = new Set(services.map((key) => key.key))
    map.forEach((_, key) => {
      if (keySet.has(key)) return
      map.delete(key)
    })
  })

/**
 * @example
 * ```ts
 * import { Option, pipe, Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const someContext = pipe(
 *   Context.make(Port, { PORT: 8080 }),
 *   Context.add(Timeout, { TIMEOUT: 5000 })
 * )
 *
 * const context = pipe(someContext, Context.omit(Timeout))
 *
 * assert.deepStrictEqual(
 *   Context.getOption(context, Port),
 *   Option.some({ PORT: 8080 })
 * )
 * assert.deepStrictEqual(Context.getOption(context, Timeout), Option.none())
 * ```
 *
 * @since 4.0.0
 * @category Utils
 */
export const omit = <S extends ReadonlyArray<Key<any, any>>>(
  ...keys: S
) =>
<Services>(self: Context<Services>): Context<Exclude<Services, Service.Identifier<S[number]>>> =>
  withMapUnsafe(self, (map) => {
    for (let i = 0; i < keys.length; i++) {
      map.delete(keys[i].key)
    }
  })

/**
 * Perform a series of mutations on a `Context`. Prevents unnecessary copying
 * of the underlying map when multiple mutations are needed.
 *
 * @since 4.0.0
 * @category Utils
 */
export const mutate: {
  <Services, B>(
    f: (context: Context<Services>) => Context<B>
  ): <Services>(self: Context<Services>) => Context<B>
  <Services, B>(self: Context<Services>, f: (context: Context<Services>) => Context<B>): Context<B>
} = dual(
  2,
  <Services, B>(self: Context<Services>, f: (context: Context<Services>) => Context<B>): Context<B> => {
    const next = makeUnsafe<Services>(new Map(self.mapUnsafe))
    next.mutable = true
    const result = f(next)
    result.mutable = false
    return result
  }
)

const withMapUnsafe = <Services, B>(self: Context<Services>, f: (map: Map<string, any>) => void): Context<B> => {
  if (self.mutable) {
    f(self.mapUnsafe as any)
    return self as any
  }
  const map = new Map(self.mapUnsafe)
  f(map)
  return makeUnsafe(map)
}

/**
 * Creates a context key with a default value.
 *
 * **Details**
 *
 * `Context.Reference` allows you to create a key that can hold a value. You
 * can provide a default value for the service, which will automatically be used
 * when the context is accessed, or override it with a custom implementation
 * when needed.
 *
 * @example
 * ```ts
 * import { Context } from "effect"
 *
 * // Create a reference with a default value
 * const LoggerRef = Context.Reference("Logger", {
 *   defaultValue: () => ({ log: (msg: string) => console.log(msg) })
 * })
 *
 * // The reference provides the default value when accessed from an empty context
 * const context = Context.empty()
 * const logger = Context.get(context, LoggerRef)
 *
 * // You can also override the default value
 * const customContext = Context.make(LoggerRef, {
 *   log: (msg: string) => `Custom: ${msg}`
 * })
 * const customLogger = Context.get(customContext, LoggerRef)
 * ```
 *
 * @since 4.0.0
 * @category References
 */
export const Reference: <Service>(
  key: string,
  options: { readonly defaultValue: () => Service }
) => Reference<Service> = Service as any
