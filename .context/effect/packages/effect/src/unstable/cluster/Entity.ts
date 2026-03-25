/**
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import type * as Cause from "../../Cause.ts"
import * as Data from "../../Data.ts"
import type * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import * as Equal from "../../Equal.ts"
import * as Exit from "../../Exit.ts"
import { identity } from "../../Function.ts"
import * as Hash from "../../Hash.ts"
import type * as Latch from "../../Latch.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import * as Queue from "../../Queue.ts"
import type * as Schedule from "../../Schedule.ts"
import { Scope } from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type * as Stream from "../../Stream.ts"
import * as Headers from "../http/Headers.ts"
import * as Rpc from "../rpc/Rpc.ts"
import * as RpcClient from "../rpc/RpcClient.ts"
import * as RpcGroup from "../rpc/RpcGroup.ts"
import * as RpcServer from "../rpc/RpcServer.ts"
import type { AlreadyProcessingMessage, MailboxFull, PersistenceError } from "./ClusterError.ts"
import { Persisted, ShardGroup, Uninterruptible } from "./ClusterSchema.ts"
import { EntityAddress } from "./EntityAddress.ts"
import type { EntityId } from "./EntityId.ts"
import { EntityType } from "./EntityType.ts"
import * as Envelope from "./Envelope.ts"
import { hashString } from "./internal/hash.ts"
import { ResourceMap } from "./internal/resourceMap.ts"
import * as Message from "./Message.ts"
import type * as Reply from "./Reply.ts"
import { RunnerAddress } from "./RunnerAddress.ts"
import * as ShardId from "./ShardId.ts"
import type { Sharding } from "./Sharding.ts"
import { ShardingConfig } from "./ShardingConfig.ts"
import * as Snowflake from "./Snowflake.ts"

const TypeId = "~effect/cluster/Entity"

/**
 * @since 4.0.0
 * @category models
 */
export interface Entity<
  in out Type extends string,
  in out Rpcs extends Rpc.Any
> extends Equal.Equal {
  readonly [TypeId]: typeof TypeId
  /**
   * The name of the entity type.
   */
  readonly type: EntityType

  /**
   * A RpcGroup definition for messages which represents the messaging protocol
   * that the entity is capable of processing.
   */
  readonly protocol: RpcGroup.RpcGroup<Rpcs>

  /**
   * Get the shard group for the given EntityId.
   */
  getShardGroup(entityId: EntityId): string

  /**
   * Get the ShardId for the given EntityId.
   */
  getShardId(entityId: EntityId): Effect.Effect<ShardId.ShardId, never, Sharding>

  /**
   * Annotate the entity with a value.
   */
  annotate<I, S>(key: ServiceMap.Key<I, S>, value: S): Entity<Type, Rpcs>

  /**
   * Annotate the Rpc's above this point with a value.
   */
  annotateRpcs<I, S>(key: ServiceMap.Key<I, S>, value: S): Entity<Type, Rpcs>

  /**
   * Annotate the entity with the given annotations.
   */
  annotateMerge<S>(annotation: ServiceMap.ServiceMap<S>): Entity<Type, Rpcs>

  /**
   * Annotate the Rpc's above this point with a context object.
   */
  annotateRpcsMerge<S>(context: ServiceMap.ServiceMap<S>): Entity<Type, Rpcs>

  /**
   * Create a client for this entity.
   */
  readonly client: Effect.Effect<
    (
      entityId: string
    ) => RpcClient.RpcClient.From<
      Rpcs,
      MailboxFull | AlreadyProcessingMessage | PersistenceError
    >,
    never,
    Sharding
  >

  /**
   * Create a Layer from an Entity.
   *
   * It will register the entity with the Sharding service.
   */
  toLayer<
    Handlers extends HandlersFrom<Rpcs>,
    RX = never
  >(
    build: Handlers | Effect.Effect<Handlers, never, RX>,
    options?: {
      readonly maxIdleTime?: Duration.Input | undefined
      readonly concurrency?: number | "unbounded" | undefined
      readonly mailboxCapacity?: number | "unbounded" | undefined
      readonly disableFatalDefects?: boolean | undefined
      readonly defectRetryPolicy?: Schedule.Schedule<any, unknown> | undefined
      readonly spanAttributes?: Record<string, string> | undefined
    }
  ): Layer.Layer<
    never,
    never,
    | Exclude<RX, Scope | CurrentAddress | CurrentRunnerAddress>
    | RpcGroup.HandlersServices<Rpcs, Handlers>
    | Rpc.ServicesClient<Rpcs>
    | Rpc.ServicesServer<Rpcs>
    | Rpc.Middleware<Rpcs>
    | Sharding
  >

  of<Handlers extends HandlersFrom<Rpcs>>(handlers: Handlers): Handlers

  /**
   * Create a Layer from an Entity.
   *
   * It will register the entity with the Sharding service.
   */
  toLayerQueue<
    R,
    RX = never
  >(
    build:
      | ((
        queue: Queue.Dequeue<Envelope.Request<Rpcs>>,
        replier: Replier<Rpcs>
      ) => Effect.Effect<never, never, R>)
      | Effect.Effect<
        (
          queue: Queue.Dequeue<Envelope.Request<Rpcs>>,
          replier: Replier<Rpcs>
        ) => Effect.Effect<never, never, R>,
        never,
        RX
      >,
    options?: {
      readonly maxIdleTime?: Duration.Input | undefined
      readonly mailboxCapacity?: number | "unbounded" | undefined
      readonly disableFatalDefects?: boolean | undefined
      readonly defectRetryPolicy?: Schedule.Schedule<any, unknown> | undefined
      readonly spanAttributes?: Record<string, string> | undefined
    }
  ): Layer.Layer<
    never,
    never,
    | Exclude<RX, Scope | CurrentAddress | CurrentRunnerAddress>
    | R
    | Rpc.ServicesClient<Rpcs>
    | Rpc.ServicesServer<Rpcs>
    | Rpc.Middleware<Rpcs>
    | Sharding
  >
}
/**
 * @since 4.0.0
 * @category models
 */
export type Any = Entity<string, Rpc.Any>

/**
 * @since 4.0.0
 * @category models
 */
export type HandlersFrom<Rpc extends Rpc.Any> = {
  readonly [Current in Rpc as Current["_tag"]]: (
    envelope: Request<Current>
  ) => Rpc.ResultFrom<Current, any> | Rpc.Wrapper<Rpc.ResultFrom<Current, any>>
}

/**
 * @since 4.0.0
 * @category refinements
 */
export const isEntity = (u: unknown): u is Any => Predicate.hasProperty(u, TypeId)

const Proto = {
  [TypeId]: TypeId,
  [Hash.symbol](this: Entity<string, any>): number {
    return Hash.structure({ type: this.type })
  },
  [Equal.symbol](this: Entity<string, any>, that: Equal.Equal): boolean {
    return isEntity(that) && this.type === that.type
  },
  annotate<I, S>(this: Entity<string, any>, key: ServiceMap.Key<I, S>, value: S) {
    return fromRpcGroup(this.type, this.protocol.annotate(key, value))
  },
  annotateRpcs<I, S>(this: Entity<string, any>, key: ServiceMap.Key<I, S>, value: S) {
    return fromRpcGroup(this.type, this.protocol.annotateRpcs(key, value))
  },
  annotateMerge<S>(this: Entity<string, any>, annotations: ServiceMap.ServiceMap<S>) {
    return fromRpcGroup(this.type, this.protocol.annotateMerge(annotations))
  },
  annotateRpcsMerge<S>(this: Entity<string, any>, annotations: ServiceMap.ServiceMap<S>) {
    return fromRpcGroup(this.type, this.protocol.annotateRpcsMerge(annotations))
  },
  getShardId(this: Entity<string, any>, entityId: EntityId) {
    return Effect.map(shardingTag.asEffect(), (sharding) => sharding.getShardId(entityId, this.getShardGroup(entityId)))
  },
  get client() {
    return shardingTag.asEffect().pipe(
      Effect.flatMap((sharding) => sharding.makeClient(this as any))
    )
  },
  toLayer<
    Rpcs extends Rpc.Any,
    Handlers extends HandlersFrom<Rpcs>,
    RX = never
  >(
    this: Entity<string, Rpcs>,
    build: Handlers | Effect.Effect<Handlers, never, RX>,
    options?: {
      readonly maxIdleTime?: Duration.Input | undefined
      readonly concurrency?: number | "unbounded" | undefined
      readonly mailboxCapacity?: number | "unbounded" | undefined
      readonly disableFatalDefects?: boolean | undefined
      readonly defectRetryPolicy?: Schedule.Schedule<any, unknown> | undefined
      readonly spanAttributes?: Record<string, string> | undefined
    }
  ): Layer.Layer<
    never,
    never,
    | Exclude<RX, Scope | CurrentAddress | CurrentRunnerAddress>
    | RpcGroup.HandlersServices<Rpcs, Handlers>
    | Rpc.ServicesClient<Rpcs>
    | Rpc.ServicesServer<Rpcs>
    | Rpc.Middleware<Rpcs>
    | Sharding
  > {
    return shardingTag.asEffect().pipe(
      Effect.flatMap((sharding) =>
        sharding.registerEntity(
          this,
          Effect.isEffect(build) ? build : Effect.succeed(build),
          options
        )
      ),
      Layer.effectDiscard
    )
  },
  of: identity,
  toLayerQueue<
    Rpcs extends Rpc.Any,
    R,
    RX = never
  >(
    this: Entity<string, Rpcs>,
    build:
      | ((
        mailbox: Queue.Dequeue<Envelope.Request<Rpcs>>,
        replier: Replier<Rpcs>
      ) => Effect.Effect<never, never, R>)
      | Effect.Effect<
        (
          mailbox: Queue.Dequeue<Envelope.Request<Rpcs>>,
          replier: Replier<Rpcs>
        ) => Effect.Effect<never, never, R>,
        never,
        RX
      >,
    options?: {
      readonly maxIdleTime?: Duration.Input | undefined
      readonly mailboxCapacity?: number | "unbounded" | undefined
      readonly disableFatalDefects?: boolean | undefined
      readonly defectRetryPolicy?: Schedule.Schedule<any, unknown> | undefined
      readonly spanAttributes?: Record<string, string> | undefined
    }
  ) {
    const buildHandlers = Effect.gen({ self: this }, function*() {
      const behaviour = Effect.isEffect(build) ? yield* build : build
      const queue = yield* Queue.make<Envelope.Request<Rpcs>>()

      // create the rpc handlers for the entity
      const handler = (envelope: any) => {
        return Effect.callback<any, any>((resume) => {
          Queue.offerUnsafe(queue, envelope)
          resumes.set(envelope, resume)
        })
      }
      const handlers: Record<string, any> = {}
      for (const rpc of this.protocol.requests.keys()) {
        handlers[rpc] = handler
      }

      // make the Replier for the behaviour
      const resumes = new Map<Envelope.Request<any>, (exit: Exit.Exit<any, any>) => void>()
      const complete = (request: Envelope.Request<any>, exit: Exit.Exit<any, any>) =>
        Effect.sync(() => {
          const resume = resumes.get(request)
          if (resume) {
            resumes.delete(request)
            resume(exit)
          }
        })
      const replier: Replier<Rpcs> = {
        succeed: (request, value) => complete(request, Exit.succeed(value)),
        fail: (request, error) => complete(request, Exit.fail(error)),
        failCause: (request, cause) => complete(request, Exit.failCause(cause)),
        complete
      }

      // fork the behaviour into the layer scope
      yield* behaviour(queue, replier).pipe(
        Effect.catchCause((cause) => {
          const exit = Exit.failCause(cause)
          for (const resume of resumes.values()) {
            resume(exit)
          }
          return Effect.void
        }),
        Effect.interruptible,
        Effect.forkScoped
      )

      return handlers as any
    })

    return this.toLayer(buildHandlers, {
      ...options,
      concurrency: "unbounded"
    })
  }
}

/**
 * Creates a new `Entity` of the specified `type` which will accept messages
 * that adhere to the provided `RpcGroup`.
 *
 * @since 4.0.0
 * @category constructors
 */
export const fromRpcGroup = <const Type extends string, Rpcs extends Rpc.Any>(
  /**
   * The entity type name.
   */
  type: Type,
  /**
   * The schema definition for messages that the entity is capable of
   * processing.
   */
  protocol: RpcGroup.RpcGroup<Rpcs>
): Entity<Type, Rpcs> => {
  const self = Object.create(Proto)
  self.type = EntityType.makeUnsafe(type)
  self.protocol = protocol
  self.getShardGroup = ServiceMap.get(protocol.annotations, ShardGroup)
  return self
}

/**
 * Creates a new `Entity` of the specified `type` which will accept messages
 * that adhere to the provided schemas.
 *
 * @since 4.0.0
 * @category constructors
 */
export const make = <const Type extends string, Rpcs extends ReadonlyArray<Rpc.Any>>(
  /**
   * The entity type name.
   */
  type: Type,
  /**
   * The schema definition for messages that the entity is capable of
   * processing.
   */
  protocol: Rpcs
): Entity<Type, Rpcs[number]> => fromRpcGroup(type, RpcGroup.make(...protocol))

/**
 * A Context.Tag to access the current entity address.
 *
 * @since 4.0.0
 * @category context
 */
export class CurrentAddress extends ServiceMap.Service<
  CurrentAddress,
  EntityAddress
>()("effect/cluster/Entity/EntityAddress") {}

/**
 * A Context.Tag to access the current Runner address.
 *
 * @since 4.0.0
 * @category context
 */
export class CurrentRunnerAddress extends ServiceMap.Service<
  CurrentRunnerAddress,
  RunnerAddress
>()("effect/cluster/Entity/RunnerAddress") {}

/**
 * @since 4.0.0
 * @category Replier
 */
export interface Replier<Rpcs extends Rpc.Any> {
  readonly succeed: <R extends Rpcs>(
    request: Envelope.Request<R>,
    value: Replier.Success<R>
  ) => Effect.Effect<void>

  readonly fail: <R extends Rpcs>(
    request: Envelope.Request<R>,
    error: Rpc.Error<R>
  ) => Effect.Effect<void>

  readonly failCause: <R extends Rpcs>(
    request: Envelope.Request<R>,
    cause: Cause.Cause<Rpc.Error<R>>
  ) => Effect.Effect<void>

  readonly complete: <R extends Rpcs>(
    request: Envelope.Request<R>,
    exit: Exit.Exit<Replier.Success<R>, Rpc.Error<R>>
  ) => Effect.Effect<void>
}

/**
 * @since 4.0.0
 * @category Replier
 */
export declare namespace Replier {
  /**
   * @since 4.0.0
   * @category Replier
   */
  export type Success<R extends Rpc.Any> = Rpc.Success<R> extends Stream.Stream<infer _A, infer _E, infer _R> ?
    Stream.Stream<_A, _E | Rpc.Error<R>, _R> | Queue.Dequeue<_A, _E | Rpc.Error<R>>
    : Rpc.Success<R>
}

/**
 * @since 4.0.0
 * @category Request
 */
export class Request<Rpc extends Rpc.Any> extends Data.Class<
  Envelope.Request<Rpc> & {
    readonly lastSentChunk: Option.Option<Reply.Chunk<Rpc>>
  }
> {
  /**
   * @since 4.0.0
   */
  get lastSentChunkValue(): Option.Option<Rpc.SuccessChunk<Rpc>> {
    return Option.map(this.lastSentChunk, (chunk) => Arr.lastNonEmpty(chunk.values))
  }

  /**
   * @since 4.0.0
   */
  get nextSequence(): number {
    if (Option.isNone(this.lastSentChunk)) {
      return 0
    }
    return this.lastSentChunk.value.sequence + 1
  }
}

const shardingTag = ServiceMap.Service<Sharding, Sharding["Service"]>("effect/cluster/Sharding")

/**
 * @since 4.0.0
 * @category Testing
 */
export const makeTestClient: <Type extends string, Rpcs extends Rpc.Any, LA, LE, LR>(
  entity: Entity<Type, Rpcs>,
  layer: Layer.Layer<LA, LE, LR>
) => Effect.Effect<
  (entityId: string) => Effect.Effect<RpcClient.RpcClient<Rpcs>>,
  LE,
  Scope | ShardingConfig | Exclude<LR, Sharding> | Rpc.MiddlewareClient<Rpcs>
> = Effect.fnUntraced(function*<Type extends string, Rpcs extends Rpc.Any, LA, LE, LR>(
  entity: Entity<Type, Rpcs>,
  layer: Layer.Layer<LA, LE, LR>
) {
  const config = yield* ShardingConfig
  const makeShardId = (entityId: string) =>
    ShardId.make(
      entity.getShardGroup(entityId as EntityId),
      (Math.abs(hashString(entityId) % config.shardsPerGroup)) + 1
    )
  const snowflakeGen = yield* Snowflake.makeGenerator
  const runnerAddress = new RunnerAddress({ host: "localhost", port: 3000 })
  const entityMap = new Map<string, {
    readonly services: ServiceMap.ServiceMap<
      Rpc.ServicesClient<Rpcs> | Rpc.ServicesServer<Rpcs> | Rpc.Middleware<Rpcs> | LR
    >
    readonly concurrency: number | "unbounded"
    readonly build: Effect.Effect<
      ServiceMap.ServiceMap<Rpc.ToHandler<Rpcs>>,
      never,
      Scope | CurrentAddress
    >
  }>()
  const sharding = shardingTag.of({
    ...({} as Sharding["Service"]),
    registerEntity: (entity, handlers, options) =>
      Effect.servicesWith((services) => {
        entityMap.set(entity.type, {
          services: services as any,
          concurrency: options?.concurrency ?? 1,
          build: entity.protocol.toHandlers(handlers as any).pipe(
            Effect.provideServices(ServiceMap.mutate(services, (services) =>
              services.pipe(
                ServiceMap.add(CurrentRunnerAddress, runnerAddress),
                ServiceMap.omit(Scope)
              )))
          ) as any
        })
        return Effect.void
      })
  })
  yield* Layer.build(Layer.provide(layer, Layer.succeed(shardingTag)(sharding)))
  const entityEntry = entityMap.get(entity.type)
  if (!entityEntry) {
    return yield* Effect.die(`Entity.makeTestClient: ${entity.type} was not registered by layer`)
  }

  const map = yield* ResourceMap.make(Effect.fnUntraced(function*(entityId: string) {
    const address = new EntityAddress({
      entityType: entity.type,
      entityId: entityId as EntityId,
      shardId: makeShardId(entityId)
    })
    const handlers = yield* entityEntry.build.pipe(
      Effect.provideService(CurrentAddress, address)
    )

    // oxlint-disable-next-line prefer-const
    let client!: Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<Rpcs, never>>>
    const server = yield* RpcServer.makeNoSerialization(entity.protocol, {
      concurrency: entityEntry.concurrency,
      onFromServer(response) {
        return client.write(response)
      }
    }).pipe(Effect.provide(handlers))

    client = yield* RpcClient.makeNoSerialization(entity.protocol, {
      supportsAck: true,
      generateRequestId: () => snowflakeGen.nextUnsafe() as any,
      onFromClient({ message }) {
        if (message._tag === "Request") {
          return server.write(0, {
            ...message,
            payload: new Request({
              ...message,
              [Envelope.TypeId]: Envelope.TypeId,
              address,
              requestId: Snowflake.Snowflake(message.id),
              lastSentChunk: Option.none()
            }) as any
          })
        }
        return server.write(0, message)
      }
    })
    return client.client
  }))

  return (entityId: string) => map.get(entityId)
})

/**
 * @since 4.0.0
 * @category Keep alive
 */
export const keepAlive: (
  enabled: boolean
) => Effect.Effect<
  void,
  never,
  Sharding | CurrentAddress
> = Effect.fnUntraced(function*(enabled: boolean) {
  const olatch = yield* Effect.serviceOption(KeepAliveLatch)
  if (olatch._tag === "None") return
  if (!enabled) {
    yield* olatch.value.open
    return
  }
  const sharding = yield* shardingTag
  const address = yield* CurrentAddress
  const requestId = yield* sharding.getSnowflake
  const span = yield* Effect.orDie(Effect.currentSpan)
  olatch.value.closeUnsafe()
  yield* Effect.orDie(sharding.sendOutgoing(
    new Message.OutgoingRequest({
      rpc: KeepAliveRpc,
      services: ServiceMap.empty() as any,
      envelope: Envelope.makeRequest({
        requestId,
        address,
        tag: KeepAliveRpc._tag,
        payload: void 0,
        headers: Headers.empty,
        traceId: span.traceId,
        spanId: span.spanId,
        sampled: span.sampled
      }),
      lastReceivedReply: Option.none(),
      respond: () => Effect.void
    }),
    true
  ))
}, (effect, enabled) =>
  Effect.withSpan(
    effect,
    "Entity/keepAlive",
    { attributes: { enabled }, captureStackTrace: false }
  ))

/**
 * @since 4.0.0
 * @category Keep alive
 */
export const KeepAliveRpc = Rpc.make("Cluster/Entity/keepAlive")
  .annotate(Persisted, true)
  .annotate(Uninterruptible, true)

/**
 * @since 4.0.0
 * @category Keep alive
 */
export class KeepAliveLatch extends ServiceMap.Service<KeepAliveLatch, Latch.Latch>()(
  "effect/cluster/Entity/KeepAliveLatch"
) {}
