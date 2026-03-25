/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import type * as Exit from "../../Exit.ts"
import * as Fiber from "../../Fiber.ts"
import { constant } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import * as Queue from "../../Queue.ts"
import * as RpcServer from "../rpc/RpcServer.ts"
import type * as ClusterError from "./ClusterError.ts"
import * as Message from "./Message.ts"
import * as MessageStorage from "./MessageStorage.ts"
import * as Reply from "./Reply.ts"
import * as RunnerHealth from "./RunnerHealth.ts"
import * as Runners from "./Runners.ts"
import type * as RunnerStorage from "./RunnerStorage.ts"
import * as Sharding from "./Sharding.ts"
import { ShardingConfig } from "./ShardingConfig.ts"

const constVoid = constant(Effect.void)

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerHandlers = Runners.Rpcs.toLayer(Effect.gen(function*() {
  const sharding = yield* Sharding.Sharding
  const storage = yield* MessageStorage.MessageStorage

  return {
    Ping: () => Effect.void,
    Notify: ({ envelope }) =>
      sharding.notify(
        envelope._tag === "Request"
          ? new Message.IncomingRequest({
            envelope,
            respond: constVoid,
            lastSentReply: Option.none()
          })
          : new Message.IncomingEnvelope({ envelope })
      ),
    Effect: ({ persisted, request }) => {
      let replyEncoded: Option.Option<Effect.Effect<Reply.Encoded, ClusterError.EntityNotAssignedToRunner>> = Option
        .none()
      let resume = (reply: Effect.Effect<Reply.Encoded, ClusterError.EntityNotAssignedToRunner>) => {
        replyEncoded = Option.some(reply)
      }
      const message = new Message.IncomingRequest({
        envelope: request,
        lastSentReply: Option.none(),
        respond(reply) {
          resume(Effect.orDie(Reply.serialize(reply)))
          return Effect.void
        }
      })
      if (persisted) {
        return Effect.callback<
          Reply.Encoded,
          ClusterError.EntityNotAssignedToRunner
        >((resume_) => {
          resume = resume_
          const parent = Fiber.getCurrent()!
          const onExit = (
            exit: Exit.Exit<
              any,
              ClusterError.EntityNotAssignedToRunner
            >
          ) => {
            if (exit._tag === "Failure") {
              resume(exit as any)
            }
          }
          const runFork = Effect.runForkWith(parent.services)
          const fiber = runFork(storage.registerReplyHandler(message))
          fiber.addObserver(onExit)
          runFork(Effect.catchTag(
            sharding.notify(message, constWaitUntilRead),
            "AlreadyProcessingMessage",
            () => Effect.void
          )).addObserver(onExit)
          return Fiber.interrupt(fiber)
        })
      }
      return Effect.andThen(
        sharding.send(message),
        Effect.callback<Reply.Encoded, ClusterError.EntityNotAssignedToRunner>((resume_) => {
          if (Option.isSome(replyEncoded)) {
            resume_(replyEncoded.value)
          } else {
            resume = resume_
          }
        })
      )
    },
    Stream: ({ persisted, request }) =>
      Effect.flatMap(
        Queue.make<Reply.Encoded, ClusterError.EntityNotAssignedToRunner>(),
        (queue) => {
          const message = new Message.IncomingRequest({
            envelope: request,
            lastSentReply: Option.none(),
            respond(reply) {
              return Effect.flatMap(Reply.serialize(reply), (reply) => {
                Queue.offerUnsafe(queue, reply)
                return Effect.void
              })
            }
          })
          return Effect.as(
            persisted ?
              Effect.andThen(
                storage.registerReplyHandler(message).pipe(
                  Effect.onError((cause) => Queue.failCause(queue, cause)),
                  Effect.forkScoped
                ),
                sharding.notify(message, constWaitUntilRead)
              ) :
              sharding.send(message),
            queue
          )
        }
      ),
    Envelope: ({ envelope }) => sharding.send(new Message.IncomingEnvelope({ envelope }))
  }
}))

const constWaitUntilRead = { waitUntilRead: true } as const

/**
 * The `RunnerServer` recieves messages from other Runners and forwards them to the
 * `Sharding` layer.
 *
 * It also responds to `Ping` requests.
 *
 * @since 4.0.0
 * @category Layers
 */
export const layer: Layer.Layer<
  never,
  never,
  RpcServer.Protocol | Sharding.Sharding | MessageStorage.MessageStorage
> = RpcServer.layer(Runners.Rpcs, {
  spanPrefix: "RunnerServer",
  disableTracing: true
}).pipe(Layer.provide(layerHandlers))

/**
 * A `RunnerServer` layer that includes the `Runners` & `Sharding` clients.
 *
 * @since 4.0.0
 * @category Layers
 */
export const layerWithClients: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | RpcServer.Protocol
  | ShardingConfig
  | Runners.RpcClientProtocol
  | MessageStorage.MessageStorage
  | RunnerStorage.RunnerStorage
  | RunnerHealth.RunnerHealth
> = layer.pipe(
  Layer.provideMerge(Sharding.layer),
  Layer.provideMerge(Runners.layerRpc)
)

/**
 * A `Runners` layer that is client only.
 *
 * It will not register with the ShardManager and recieve shard assignments,
 * so this layer can be used to embed a cluster client inside another effect
 * application.
 *
 * @since 4.0.0
 * @category Layers
 */
export const layerClientOnly: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | ShardingConfig
  | Runners.RpcClientProtocol
  | MessageStorage.MessageStorage
  | RunnerStorage.RunnerStorage
> = Sharding.layer.pipe(
  Layer.provideMerge(Runners.layerRpc),
  Layer.provide(RunnerHealth.layerNoop),
  Layer.updateService(ShardingConfig, (config) => ({
    ...config,
    runnerAddress: Option.none()
  }))
)
