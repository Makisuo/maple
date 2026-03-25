/**
 * @since 4.0.0
 */
import type * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import { identity } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import type { Pipeable } from "../../Pipeable.ts"
import type * as Queue from "../../Queue.ts"
import type * as Record from "../../Record.ts"
import type { Scope } from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Stream from "../../Stream.ts"
import type { Headers } from "../http/Headers.ts"
import * as Rpc from "./Rpc.ts"
import type { RequestId } from "./RpcMessage.ts"
import type * as RpcMiddleware from "./RpcMiddleware.ts"

const TypeId = "~effect/rpc/RpcGroup"

/**
 * @since 4.0.0
 * @category groups
 */
export interface RpcGroup<in out R extends Rpc.Any> extends Pipeable {
  new(_: never): {}

  readonly [TypeId]: typeof TypeId
  readonly requests: ReadonlyMap<string, R>
  readonly annotations: ServiceMap.ServiceMap<never>

  /**
   * Add one or more procedures to the group.
   */
  add<const Rpcs2 extends ReadonlyArray<Rpc.Any>>(
    ...rpcs: Rpcs2
  ): RpcGroup<R | Rpcs2[number]>

  /**
   * Merge this group with one or more other groups.
   */
  merge<const Groups extends ReadonlyArray<Any>>(
    ...groups: Groups
  ): RpcGroup<R | Rpcs<Groups[number]>>

  /**
   * Add middleware to all the procedures added to the group until this point.
   */
  middleware<M extends RpcMiddleware.AnyService>(middleware: M): RpcGroup<Rpc.AddMiddleware<R, M>>

  /**
   * Add a prefix to the procedures in this group, returning a new group
   */
  prefix<const Prefix extends string>(prefix: Prefix): RpcGroup<Rpc.Prefixed<R, Prefix>>

  /**
   * Implement the handlers for the procedures in this group, returning a
   * context object.
   */
  toHandlers<
    Handlers extends HandlersFrom<R>,
    EX = never,
    RX = never
  >(
    build:
      | Handlers
      | Effect.Effect<Handlers, EX, RX>
  ): Effect.Effect<
    ServiceMap.ServiceMap<Rpc.ToHandler<R>>,
    EX,
    | RX
    | HandlersServices<R, Handlers>
  >

  /**
   * Implement the handlers for the procedures in this group.
   */
  toLayer<
    Handlers extends HandlersFrom<R>,
    EX = never,
    RX = never
  >(
    build:
      | Handlers
      | Effect.Effect<Handlers, EX, RX>
  ): Layer.Layer<
    Rpc.ToHandler<R>,
    EX,
    | Exclude<RX, Scope>
    | HandlersServices<R, Handlers>
  >

  of<const Handlers extends HandlersFrom<R>>(handlers: Handlers): Handlers

  /**
   * Implement a single handler from the group.
   */
  toLayerHandler<
    const Tag extends R["_tag"],
    Handler extends HandlerFrom<R, Tag>,
    EX = never,
    RX = never
  >(
    tag: Tag,
    build:
      | Handler
      | Effect.Effect<Handler, EX, RX>
  ): Layer.Layer<
    Rpc.Handler<Tag>,
    EX,
    | Exclude<RX, Scope>
    | HandlerServices<R, Tag, Handler>
  >

  /**
   * Retrieve a handler for a specific procedure in the group.
   */
  accessHandler<const Tag extends R["_tag"]>(tag: Tag): Effect.Effect<
    (
      payload: Rpc.Payload<Extract<R, { readonly _tag: Tag }>>,
      options: {
        readonly clientId: number
        readonly requestId: RequestId
        readonly headers: Headers
      }
    ) => Rpc.ResultFrom<Extract<R, { readonly _tag: Tag }>, never>,
    never,
    Rpc.Handler<Tag>
  >

  /**
   * Annotate the group with a value.
   */
  annotate<I, S>(service: ServiceMap.Key<I, S>, value: S): RpcGroup<R>

  /**
   * Annotate the Rpc's above this point with a value.
   */
  annotateRpcs<I, S>(service: ServiceMap.Key<I, S>, value: S): RpcGroup<R>

  /**
   * Annotate the group with the provided annotations.
   */
  annotateMerge<S>(annotations: ServiceMap.ServiceMap<S>): RpcGroup<R>

  /**
   * Annotate the Rpc's above this point with the provided annotations.
   */
  annotateRpcsMerge<S>(annotations: ServiceMap.ServiceMap<S>): RpcGroup<R>
}

/**
 * @since 4.0.0
 * @category groups
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
}

/**
 * @since 4.0.0
 * @category groups
 */
export type HandlersFrom<Rpc extends Rpc.Any> = {
  readonly [Current in Rpc as Current["_tag"]]: Rpc.ToHandlerFn<Current>
}

/**
 * @since 4.0.0
 * @category groups
 */
export type HandlerFrom<Rpc extends Rpc.Any, Tag extends Rpc["_tag"]> = Extract<Rpc, { readonly _tag: Tag }> extends
  infer Current ? Current extends Rpc.Any ? Rpc.ToHandlerFn<Current> : never : never

/**
 * @since 4.0.0
 * @category groups
 */
export type HandlersServices<Rpcs extends Rpc.Any, Handlers> = keyof Handlers extends infer K ?
  K extends keyof Handlers & string ? HandlerServices<Rpcs, K, Handlers[K]> : never :
  never

/**
 * @since 4.0.0
 * @category groups
 */
export type HandlerServices<Rpcs extends Rpc.Any, K extends Rpcs["_tag"], Handler> = true extends
  Rpc.IsStream<Rpcs, K> ? Handler extends (...args: any) =>
    | Stream.Stream<infer _A, infer _E, infer _R>
    | Rpc.Wrapper<Stream.Stream<infer _A, infer _E, infer _R>>
    | Effect.Effect<
      Queue.Dequeue<infer _A, infer _E | Cause.Done>,
      infer _EX,
      infer _R
    >
    | Rpc.Wrapper<
      Effect.Effect<
        Queue.Dequeue<infer _A, infer _E | Cause.Done>,
        infer _EX,
        infer _R
      >
    > ? Exclude<Rpc.ExcludeProvides<_R, Rpcs, K>, Scope> | Rpc.ExtractRequires<Rpcs, K> :
  never :
  Handler extends (
    ...args: any
  ) => Effect.Effect<infer _A, infer _E, infer _R> | Rpc.Wrapper<Effect.Effect<infer _A, infer _E, infer _R>> ?
    Exclude<Rpc.ExcludeProvides<_R, Rpcs, K>, Scope> | Rpc.ExtractRequires<Rpcs, K>
  : never

/**
 * @since 4.0.0
 * @category groups
 */
export type Rpcs<Group> = Group extends RpcGroup<infer R> ? string extends R["_tag"] ? never : R : never

const RpcGroupProto = {
  add(this: RpcGroup<any>, ...rpcs: Array<Rpc.Any>) {
    const requests = new Map(this.requests)
    for (const rpc of rpcs) {
      requests.set(rpc._tag, rpc)
    }
    return makeProto({
      requests,
      annotations: this.annotations
    })
  },
  merge(this: RpcGroup<any>, ...groups: ReadonlyArray<RpcGroup<any>>) {
    const requests = new Map(this.requests)
    const annotations = new Map(this.annotations.mapUnsafe)

    for (const group of groups) {
      for (const [tag, rpc] of group.requests) {
        requests.set(tag, rpc)
      }
      for (const [key, value] of group.annotations.mapUnsafe) {
        annotations.set(key, value)
      }
    }

    return makeProto({
      requests,
      annotations: ServiceMap.makeUnsafe(annotations)
    })
  },
  middleware(this: RpcGroup<any>, middleware: RpcMiddleware.AnyService) {
    const requests = new Map<string, any>()
    for (const [tag, rpc] of this.requests) {
      requests.set(tag, rpc.middleware(middleware))
    }
    return makeProto({
      requests,
      annotations: this.annotations
    })
  },
  toHandlers(this: RpcGroup<any>, build: Effect.Effect<Record<string, (request: any) => any>>) {
    // oxlint-disable-next-line no-this-alias
    const self = this
    return Effect.gen(function*() {
      const services = yield* Effect.services<never>()
      const handlers = Effect.isEffect(build) ? yield* build : build
      const contextMap = new Map<string, unknown>()
      for (const [tag, handler] of Object.entries(handlers)) {
        const rpc = self.requests.get(tag)!
        contextMap.set(rpc.key, {
          tag: rpc._tag,
          handler,
          services
        })
      }
      return ServiceMap.makeUnsafe(contextMap)
    })
  },
  prefix<const Prefix extends string>(this: RpcGroup<any>, prefix: Prefix) {
    const requests = new Map<string, any>()
    for (const rpc of this.requests.values()) {
      const newRpc = rpc.prefix(prefix)
      requests.set(newRpc._tag, newRpc)
    }
    return makeProto({
      requests,
      annotations: this.annotations
    })
  },
  toLayer(this: RpcGroup<any>, build: Effect.Effect<Record<string, (request: any) => any>>) {
    return Layer.effectServices(this.toHandlers(build))
  },
  of: identity,
  toLayerHandler(this: RpcGroup<any>, service: string, build: Effect.Effect<Record<string, (request: any) => any>>) {
    // oxlint-disable-next-line no-this-alias
    const self = this
    return Layer.effectServices(Effect.gen(function*() {
      const services = yield* Effect.services<never>()
      const handler = Effect.isEffect(build) ? yield* build : build
      const contextMap = new Map<string, unknown>()
      const rpc = self.requests.get(service)!
      contextMap.set(rpc.key, {
        handler,
        services
      })
      return ServiceMap.makeUnsafe(contextMap)
    }))
  },
  accessHandler(this: RpcGroup<any>, service: string) {
    return Effect.servicesWith((parentServices: ServiceMap.ServiceMap<any>) => {
      const rpc = this.requests.get(service)!
      const { handler, services } = parentServices.mapUnsafe.get(rpc.key) as Rpc.Handler<any>
      return Effect.succeed((payload: Rpc.Payload<any>, options: any) => {
        options.rpc = rpc
        const result = handler(payload, options)
        const effectOrStream = Rpc.isWrapper(result) ? result.value : result
        return Effect.isEffect(effectOrStream)
          ? Effect.provide(effectOrStream, services)
          : Stream.provideServices(effectOrStream, services)
      })
    })
  },
  annotate(this: RpcGroup<any>, service: ServiceMap.Key<any, any>, value: any) {
    return makeProto({
      requests: this.requests,
      annotations: ServiceMap.add(this.annotations, service, value)
    })
  },
  annotateRpcs(this: RpcGroup<any>, service: ServiceMap.Key<any, any>, value: any) {
    return this.annotateRpcsMerge(ServiceMap.make(service, value))
  },
  annotateMerge(this: RpcGroup<any>, context: ServiceMap.ServiceMap<any>) {
    return makeProto({
      requests: this.requests,
      annotations: ServiceMap.merge(this.annotations, context)
    })
  },
  annotateRpcsMerge(this: RpcGroup<any>, serviceMap: ServiceMap.ServiceMap<any>) {
    const requests = new Map<string, any>()
    for (const [tag, rpc] of this.requests) {
      requests.set(tag, rpc.annotateMerge(ServiceMap.merge(serviceMap, rpc.annotations)))
    }
    return makeProto({
      requests,
      annotations: this.annotations
    })
  }
}

const makeProto = <Rpcs extends Rpc.Any>(options: {
  readonly requests: ReadonlyMap<string, Rpcs>
  readonly annotations: ServiceMap.ServiceMap<never>
}): RpcGroup<Rpcs> =>
  Object.assign(function() {}, RpcGroupProto, {
    requests: options.requests,
    annotations: options.annotations
  }) as any

/**
 * @since 4.0.0
 * @category groups
 */
export const make = <const Rpcs extends ReadonlyArray<Rpc.Any>>(
  ...rpcs: Rpcs
): RpcGroup<Rpcs[number]> =>
  makeProto({
    requests: new Map(rpcs.map((rpc) => [rpc._tag, rpc])),
    annotations: ServiceMap.empty()
  })
