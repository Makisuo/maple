/**
 * The `Request` module provides a way to model requests to external data sources
 * in a functional and composable manner. Requests represent descriptions of
 * operations that can be batched, cached, and executed efficiently.
 *
 * A `Request<A, E, R>` represents a request that:
 * - Yields a value of type `A` on success
 * - Can fail with an error of type `E`
 * - Requires services of type `R`
 *
 * Requests are primarily used with RequestResolver to implement efficient
 * data fetching patterns, including automatic batching and caching.
 *
 * @since 2.0.0
 */
import type * as Cause from "./Cause.ts"
import type * as Effect from "./Effect.ts"
import * as Equal from "./Equal.ts"
import type * as Exit from "./Exit.ts"
import { dual } from "./Function.ts"
import * as core from "./internal/core.ts"
import * as internalEffect from "./internal/effect.ts"
import { hasProperty } from "./Predicate.ts"
import type * as ServiceMap from "./ServiceMap.ts"
import type * as Types from "./Types.ts"

const TypeId = "~effect/Request"

/**
 * A `Request<A, E, R>` is a request from a data source for a value of type `A`
 * that may fail with an `E` and have requirements of type `R`.
 *
 * @example
 * ```ts
 * import type { Request } from "effect"
 *
 * // Define a request that fetches a user by ID
 * interface GetUser extends Request.Request<string, Error> {
 *   readonly _tag: "GetUser"
 *   readonly id: number
 * }
 *
 * // Define a request that fetches all users
 * interface GetAllUsers extends Request.Request<ReadonlyArray<string>, Error> {
 *   readonly _tag: "GetAllUsers"
 * }
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface Request<out A, out E = never, out R = never> extends Variance<A, E, R> {}

/**
 * @since 2.0.0
 * @category models
 */
export type Any = Request<any, any, any>

/**
 * @since 2.0.0
 * @category models
 */
export interface Variance<out A, out E, out R> {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
    readonly _R: Types.Covariant<R>
  }
}

/**
 * @example
 * ```ts
 * import { Request } from "effect"
 *
 * interface GetUser extends Request.Request<string, Error> {
 *   readonly _tag: "GetUser"
 *   readonly id: number
 * }
 *
 * // Constructor type is used internally by Request.of() and Request.tagged()
 * const GetUser = Request.tagged<GetUser>("GetUser")
 * const userRequest = GetUser({ id: 123 })
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface Constructor<R extends Request<any, any, any>, T extends keyof R = never> {
  (args: Types.VoidIfEmpty<Types.Simplify<Omit<R, T | keyof (Variance<any, any, any>)>>>): R
}

/**
 * A utility type to extract the error type from a `Request`.
 *
 * @example
 * ```ts
 * import type { Request } from "effect"
 *
 * interface GetUser extends Request.Request<string, Error> {
 *   readonly id: number
 * }
 *
 * // Extract the error type from a Request using the utility
 * type UserError = Request.Error<GetUser> // Error
 * ```
 *
 * @since 2.0.0
 * @category type-level
 */
export type Error<T extends Request<any, any, any>> = [T] extends [Request<infer _A, infer _E, infer _R>] ? _E : never

/**
 * A utility type to extract the value type from a `Request`.
 *
 * @example
 * ```ts
 * import type { Request } from "effect"
 *
 * interface GetUser extends Request.Request<string, Error> {
 *   readonly _tag: "GetUser"
 *   readonly id: number
 * }
 *
 * // Extract the success type from a Request using the utility
 * type UserSuccess = Request.Success<GetUser> // string
 * ```
 *
 * @since 2.0.0
 * @category type-level
 */
export type Success<T extends Request<any, any, any>> = [T] extends [Request<infer _A, infer _E, infer _R>] ? _A
  : never

/**
 * A utility type to extract the requirements type from a `Request`.
 *
 * @since 4.0.0
 * @category type-level
 */
export type Services<T extends Request<any, any, any>> = [T] extends [Request<infer _A, infer _E, infer _R>] ? _R
  : never

/**
 * A utility type to extract the result type from a `Request`.
 *
 * @example
 * ```ts
 * import type { Request } from "effect"
 *
 * interface GetUser extends Request.Request<string, Error> {
 *   readonly _tag: "GetUser"
 *   readonly id: number
 * }
 *
 * // Extract the result type from a Request using the utility
 * type UserResult = Request.Result<GetUser> // Exit.Exit<string, Error>
 * ```
 *
 * @since 2.0.0
 * @category type-level
 */
export type Result<T extends Request<any, any, any>> = T extends Request<infer A, infer E, infer _R> ? Exit.Exit<A, E>
  : never

const requestVariance = Equal.byReferenceUnsafe({
  /* c8 ignore next */
  _E: (_: never) => _,
  /* c8 ignore next */
  _A: (_: never) => _,
  /* c8 ignore next */
  _R: (_: never) => _
})

/**
 * @since 4.0.0
 */
export const RequestPrototype: Request<any, any, any> = {
  ...core.StructuralProto,
  [TypeId]: requestVariance
}

/**
 * Tests if a value is a `Request`.
 *
 * @example
 * ```ts
 * import { Request } from "effect"
 *
 * declare const User: unique symbol
 * declare const UserNotFound: unique symbol
 * type User = typeof User
 * type UserNotFound = typeof UserNotFound
 *
 * interface GetUser extends Request.Request<User, UserNotFound> {
 *   readonly _tag: "GetUser"
 *   readonly id: string
 * }
 * const GetUser = Request.tagged<GetUser>("GetUser")
 *
 * const request = GetUser({ id: "123" })
 * console.log(Request.isRequest(request)) // true
 * console.log(Request.isRequest("not a request")) // false
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isRequest = (u: unknown): u is Request<unknown, unknown, unknown> => hasProperty(u, TypeId)

/**
 * Creates a constructor function for a specific Request type.
 *
 * @example
 * ```ts
 * import { Request } from "effect"
 *
 * declare const UserProfile: unique symbol
 * declare const ProfileError: unique symbol
 * type UserProfile = typeof UserProfile
 * type ProfileError = typeof ProfileError
 *
 * interface GetUserProfile extends Request.Request<UserProfile, ProfileError> {
 *   readonly id: string
 *   readonly includeSettings: boolean
 * }
 *
 * const GetUserProfile = Request.of<GetUserProfile>()
 *
 * const request = GetUserProfile({
 *   id: "user-123",
 *   includeSettings: true
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const of = <R extends Request<any, any, any>>(): Constructor<R> => (args) =>
  Object.assign(Object.create(RequestPrototype), args)

/**
 * Creates a constructor function for a tagged Request type. The tag is automatically
 * added to the request, making it useful for discriminated unions.
 *
 * @example
 * ```ts
 * import { Request } from "effect"
 *
 * declare const User: unique symbol
 * declare const UserNotFound: unique symbol
 * declare const Post: unique symbol
 * declare const PostNotFound: unique symbol
 * type User = typeof User
 * type UserNotFound = typeof UserNotFound
 * type Post = typeof Post
 * type PostNotFound = typeof PostNotFound
 *
 * interface GetUser extends Request.Request<User, UserNotFound> {
 *   readonly _tag: "GetUser"
 *   readonly id: string
 * }
 *
 * interface GetPost extends Request.Request<Post, PostNotFound> {
 *   readonly _tag: "GetPost"
 *   readonly id: string
 * }
 *
 * const GetUser = Request.tagged<GetUser>("GetUser")
 * const GetPost = Request.tagged<GetPost>("GetPost")
 *
 * const userRequest = GetUser({ id: "user-123" })
 * const postRequest = GetPost({ id: "post-456" })
 *
 * // _tag is automatically set
 * console.log(userRequest._tag) // "GetUser"
 * console.log(postRequest._tag) // "GetPost"
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const tagged = <R extends Request<any, any, any> & { _tag: string }>(
  tag: R["_tag"]
): Constructor<R, "_tag"> =>
(args) => {
  const request = Object.create(RequestPrototype)
  if (args) Object.assign(request, args)
  request._tag = tag
  return request
}

/**
 * @example
 * ```ts
 * import { Request } from "effect"
 *
 * class GetUser extends Request.Class<{ id: number }, string, Error> {
 *   constructor(readonly id: number) {
 *     super({ id })
 *   }
 * }
 *
 * const getUserRequest = new GetUser(123)
 * console.log(getUserRequest.id) // 123
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const Class: new<A extends Record<string, any>, Success, Error = never, ServiceMap = never>(
  args: Types.Equals<Omit<A, keyof Request<unknown, unknown>>, {}> extends true ? void
    : { readonly [P in keyof A as P extends keyof Request<any, any, any> ? never : P]: A[P] }
) => Request<Success, Error, ServiceMap> & Readonly<A> = (function() {
  function Class(this: any, args: any) {
    if (args) {
      Object.assign(this, args)
    }
  }
  Class.prototype = RequestPrototype
  return Class as any
})()

/**
 * @example
 * ```ts
 * import { Request } from "effect"
 *
 * class GetUserById
 *   extends Request.TaggedClass("GetUserById")<{ id: number }, string, Error>
 * {}
 *
 * const request = new GetUserById({ id: 123 })
 * console.log(request._tag) // "GetUserById"
 * console.log(request.id) // 123
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const TaggedClass = <Tag extends string>(
  tag: Tag
): new<A extends Record<string, any>, Success, Error = never, Services = never>(
  args: Types.Equals<Omit<A, keyof Request<unknown, unknown>>, {}> extends true ? void
    : { readonly [P in keyof A as P extends "_tag" | keyof Request<any, any, any> ? never : P]: A[P] }
) => Request<Success, Error, Services> & Readonly<A> & { readonly _tag: Tag } => {
  return class TaggedClass extends Class<any, any, any> {
    readonly _tag = tag
  } as any
}

/**
 * Completes a request entry with the provided result. This is typically used
 * within RequestResolver implementations to fulfill pending requests.
 *
 * @category completion
 * @since 2.0.0
 */
export const complete: {
  <A extends Any>(result: Result<A>): (self: Entry<A>) => Effect.Effect<void>
  <A extends Any>(self: Entry<A>, result: Result<A>): Effect.Effect<void>
} = dual(
  2,
  <A extends Any>(self: Entry<A>, result: Result<A>): Effect.Effect<void> =>
    internalEffect.sync(() => self.completeUnsafe(result))
)

/**
 * @since 2.0.0
 * @category completion
 */
export const completeEffect: {
  <A extends Any, R>(effect: Effect.Effect<Success<A>, Error<A>, R>): (self: Entry<A>) => Effect.Effect<void, never, R>
  <A extends Any, R>(self: Entry<A>, effect: Effect.Effect<Success<A>, Error<A>, R>): Effect.Effect<void, never, R>
} = dual(
  2,
  <A extends Any, R>(self: Entry<A>, effect: Effect.Effect<Success<A>, Error<A>, R>): Effect.Effect<void, never, R> =>
    internalEffect.matchEffect(effect, {
      onFailure: (error) => complete(self, core.exitFail(error) as any),
      onSuccess: (value) => complete(self, core.exitSucceed(value) as any)
    })
)

/**
 * @since 2.0.0
 * @category completion
 */
export const fail: {
  <A extends Any>(error: Error<A>): (self: Entry<A>) => Effect.Effect<void>
  <A extends Any>(self: Entry<A>, error: Error<A>): Effect.Effect<void>
} = dual(
  2,
  <A extends Any>(self: Entry<A>, error: Error<A>): Effect.Effect<void> => complete(self, core.exitFail(error) as any)
)

/**
 * @since 2.0.0
 * @category completion
 */
export const failCause: {
  <A extends Any>(cause: Cause.Cause<Error<A>>): (self: Entry<A>) => Effect.Effect<void>
  <A extends Any>(self: Entry<A>, cause: Cause.Cause<Error<A>>): Effect.Effect<void>
} = dual(
  2,
  <A extends Any>(self: Entry<A>, cause: Cause.Cause<Error<A>>): Effect.Effect<void> =>
    complete(self, core.exitFailCause(cause) as any)
)

/**
 * @since 2.0.0
 * @category completion
 */
export const succeed: {
  <A extends Any>(value: Success<A>): (self: Entry<A>) => Effect.Effect<void>
  <A extends Any>(self: Entry<A>, value: Success<A>): Effect.Effect<void>
} = dual(
  2,
  <A extends Any>(self: Entry<A>, value: Success<A>): Effect.Effect<void> =>
    complete(self, core.exitSucceed(value) as any)
)

/**
 * @since 2.0.0
 * @category entry
 */
export interface Entry<out R> {
  readonly request: R
  readonly services: ServiceMap.ServiceMap<
    [R] extends [Request<infer _A, infer _E, infer _R>] ? _R : never
  >
  uninterruptible: boolean
  completeUnsafe(
    exit: Exit.Exit<
      [R] extends [Request<infer _A, infer _E, infer _R>] ? _A : never,
      [R] extends [Request<infer _A, infer _E, infer _R>] ? _E : never
    >
  ): void
}

/**
 * @since 2.0.0
 * @category entry
 */
export const makeEntry = <R>(options: {
  readonly request: R
  readonly services: ServiceMap.ServiceMap<
    [R] extends [Request<infer _A, infer _E, infer _R>] ? _R : never
  >
  readonly uninterruptible: boolean
  readonly completeUnsafe: (
    exit: Exit.Exit<
      [R] extends [Request<infer _A, infer _E, infer _R>] ? _A : never,
      [R] extends [Request<infer _A, infer _E, infer _R>] ? _E : never
    >
  ) => void
}): Entry<R> => options
