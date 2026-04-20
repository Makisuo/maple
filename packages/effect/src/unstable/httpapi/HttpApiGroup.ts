/**
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import * as Context from "../../Context.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as Record from "../../Record.ts"
import type { PathInput } from "../http/HttpRouter.ts"
import type * as HttpApiEndpoint from "./HttpApiEndpoint.ts"
import type * as HttpApiMiddleware from "./HttpApiMiddleware.ts"

const TypeId = "~effect/httpapi/HttpApiGroup"

/**
 * @since 4.0.0
 * @category guards
 */
export const isHttpApiGroup = (u: unknown): u is Any => Predicate.hasProperty(u, TypeId)

/**
 * An `HttpApiGroup` is a collection of `HttpApiEndpoint`s. You can use an `HttpApiGroup` to
 * represent a portion of your domain.
 *
 * The endpoints can be implemented later using the `HttpApiBuilder.group` api.
 *
 * @since 4.0.0
 * @category models
 */
export interface HttpApiGroup<
  out Id extends string,
  out Endpoints extends HttpApiEndpoint.Any = never,
  out TopLevel extends boolean = false
> extends Pipeable {
  new(_: never): {}
  readonly [TypeId]: typeof TypeId
  readonly identifier: Id
  readonly key: string
  readonly topLevel: TopLevel
  readonly endpoints: Record.ReadonlyRecord<string, Endpoints>
  readonly annotations: Context.Context<never>

  /**
   * Add an `HttpApiEndpoint` to an `HttpApiGroup`.
   */
  add<A extends NonEmptyReadonlyArray<HttpApiEndpoint.Any>>(
    ...endpoints: A
  ): HttpApiGroup<Id, Endpoints | A[number], TopLevel>

  /**
   * Add a path prefix to all endpoints in an `HttpApiGroup`. Note that this will only
   * add the prefix to the endpoints before this api is called.
   */
  prefix<const Prefix extends PathInput>(
    prefix: Prefix
  ): HttpApiGroup<Id, HttpApiEndpoint.AddPrefix<Endpoints, Prefix>, TopLevel>

  /**
   * Add an `HttpApiMiddleware` to the `HttpApiGroup`.
   *
   * Endpoints added after this api is called **will not** have the middleware
   * applied.
   */
  middleware<I extends HttpApiMiddleware.AnyId, S>(middleware: Context.Key<I, S>): HttpApiGroup<
    Id,
    HttpApiEndpoint.AddMiddleware<Endpoints, I>,
    TopLevel
  >

  /**
   * Merge the annotations of an `HttpApiGroup` with the provided annotations.
   */
  annotateMerge<I>(annotations: Context.Context<I>): HttpApiGroup<Id, Endpoints, TopLevel>

  /**
   * Add an annotation to an `HttpApiGroup`.
   */
  annotate<I, S>(key: Context.Key<I, S>, value: S): HttpApiGroup<Id, Endpoints, TopLevel>

  /**
   * For each endpoint in an `HttpApiGroup`, update the annotations with a new
   * Context.
   *
   * Note that this will only update the annotations before this api is called.
   */
  annotateEndpointsMerge<I>(annotations: Context.Context<I>): HttpApiGroup<Id, Endpoints, TopLevel>

  /**
   * For each endpoint in an `HttpApiGroup`, add an annotation.
   *
   * Note that this will only add the annotation to the endpoints before this api
   * is called.
   */
  annotateEndpoints<I, S>(key: Context.Key<I, S>, value: S): HttpApiGroup<Id, Endpoints, TopLevel>
}

/**
 * @since 4.0.0
 * @category models
 */
export interface ApiGroup<ApiId extends string, Name extends string> {
  readonly _: unique symbol
  readonly apiId: ApiId
  readonly name: Name
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
  readonly identifier: string
  readonly key: string
  readonly endpoints: Record.ReadonlyRecord<string, HttpApiEndpoint.Any>
}

/**
 * @since 4.0.0
 * @category models
 */
export type AnyWithProps = HttpApiGroup<string, HttpApiEndpoint.AnyWithProps, boolean>

/**
 * @since 4.0.0
 * @category models
 */
export type ToService<ApiId extends string, A> = A extends HttpApiGroup<infer Name, infer _Endpoints, infer _TopLevel> ?
  ApiGroup<ApiId, Name>
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type WithName<Group, Name extends string> = Extract<Group, { readonly identifier: Name }>

/**
 * @since 4.0.0
 * @category models
 */
export type Name<Group> = Group extends HttpApiGroup<infer _Name, infer _Endpoints, infer _TopLevel> ? _Name
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type Endpoints<Group> = Group extends HttpApiGroup<infer _Name, infer _Endpoints, infer _TopLevel> ? _Endpoints
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type ErrorServicesEncode<Group> = HttpApiEndpoint.ErrorServicesEncode<Endpoints<Group>>

/**
 * @since 4.0.0
 * @category models
 */
export type ErrorServicesDecode<Group> = HttpApiEndpoint.ErrorServicesDecode<Endpoints<Group>>

/**
 * @since 4.0.0
 * @category models
 */
export type MiddlewareError<Group> = HttpApiEndpoint.MiddlewareError<Endpoints<Group>>

/**
 * @since 4.0.0
 * @category models
 */
export type MiddlewareProvides<Group> = HttpApiEndpoint.MiddlewareProvides<Endpoints<Group>>

/**
 * @since 4.0.0
 * @category models
 */
export type MiddlewareClient<Group> = HttpApiEndpoint.MiddlewareClient<Endpoints<Group>>

/**
 * @since 4.0.0
 * @category models
 */
export type MiddlewareServices<Group> = HttpApiEndpoint.MiddlewareServices<Endpoints<Group>>

/**
 * @since 4.0.0
 * @category models
 */
export type EndpointsWithName<Group extends Any, Name extends string> = Endpoints<WithName<Group, Name>>

/**
 * @since 4.0.0
 * @category models
 */
export type ClientServices<Group> = Group extends HttpApiGroup<infer _Name, infer _Endpoints, infer _TopLevel> ?
  HttpApiEndpoint.ClientServices<_Endpoints>
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type AddPrefix<Group, Prefix extends PathInput> = Group extends
  HttpApiGroup<infer _Name, infer _Endpoints, infer _TopLevel> ?
  HttpApiGroup<_Name, HttpApiEndpoint.AddPrefix<_Endpoints, Prefix>, _TopLevel>
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type AddMiddleware<Group, Id extends HttpApiMiddleware.AnyId> = Group extends
  HttpApiGroup<infer _Name, infer _Endpoints, infer _TopLevel> ?
  HttpApiGroup<_Name, HttpApiEndpoint.AddMiddleware<_Endpoints, Id>, _TopLevel>
  : never

const Proto = {
  [TypeId]: TypeId,
  add(this: AnyWithProps, ...toAdd: NonEmptyReadonlyArray<HttpApiEndpoint.AnyWithProps>) {
    const endpoints = { ...this.endpoints }
    for (const endpoint of toAdd) {
      endpoints[endpoint.name] = endpoint
    }
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints,
      annotations: this.annotations
    })
  },
  prefix(this: AnyWithProps, prefix: PathInput) {
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints: Record.map(this.endpoints, (endpoint) => endpoint.prefix(prefix)),
      annotations: this.annotations
    })
  },
  middleware(this: AnyWithProps, middleware: HttpApiMiddleware.AnyService) {
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints: Record.map(this.endpoints, (endpoint) => endpoint.middleware(middleware as any)),
      annotations: this.annotations
    })
  },
  annotateMerge<I>(this: AnyWithProps, annotations: Context.Context<I>) {
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints: this.endpoints,
      annotations: Context.merge(this.annotations, annotations)
    })
  },
  annotate<I, S>(this: AnyWithProps, annotation: Context.Key<I, S>, value: S) {
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints: this.endpoints,
      annotations: Context.add(this.annotations, annotation, value)
    })
  },
  annotateEndpointsMerge<I>(this: AnyWithProps, annotations: Context.Context<I>) {
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints: Record.map(this.endpoints, (endpoint) => endpoint.annotateMerge(annotations)),
      annotations: this.annotations
    })
  },
  annotateEndpoints<I, S>(this: AnyWithProps, annotation: Context.Key<I, S>, value: S) {
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints: Record.map(this.endpoints, (endpoint) => endpoint.annotate(annotation, value)),
      annotations: this.annotations
    })
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const makeProto = <
  Id extends string,
  Endpoints extends HttpApiEndpoint.Any,
  TopLevel extends (true | false)
>(options: {
  readonly identifier: Id
  readonly topLevel: TopLevel
  readonly endpoints: Record.ReadonlyRecord<string, Endpoints>
  readonly annotations: Context.Context<never>
}): HttpApiGroup<Id, Endpoints, TopLevel> => {
  function HttpApiGroup() {}
  Object.setPrototypeOf(HttpApiGroup, Proto)
  HttpApiGroup.key = `effect/httpapi/HttpApiGroup/${options.identifier}`
  return Object.assign(HttpApiGroup, options) as any
}

/**
 * An `HttpApiGroup` is a collection of `HttpApiEndpoint`s. You can use an `HttpApiGroup` to
 * represent a portion of your domain.
 *
 * The endpoints can be implemented later using the `HttpApiBuilder.group` api.
 *
 * @since 4.0.0
 * @category constructors
 */
export const make = <const Id extends string, const TopLevel extends boolean = false>(identifier: Id, options?: {
  readonly topLevel?: TopLevel | undefined
}): HttpApiGroup<Id, never, TopLevel> =>
  makeProto({
    identifier,
    topLevel: options?.topLevel ?? false as any,
    endpoints: Record.empty(),
    annotations: Context.empty()
  }) as any
