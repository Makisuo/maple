/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import type * as RpcSerialization from "../rpc/RpcSerialization.ts"
import * as RpcServer from "../rpc/RpcServer.ts"
import { SocketServer } from "../socket/SocketServer.ts"
import type { MessageStorage } from "./MessageStorage.ts"
import type { RunnerHealth } from "./RunnerHealth.ts"
import type * as Runners from "./Runners.ts"
import * as RunnerServer from "./RunnerServer.ts"
import type * as RunnerStorage from "./RunnerStorage.ts"
import type * as Sharding from "./Sharding.ts"
import type { ShardingConfig } from "./ShardingConfig.ts"

const withLogAddress = <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, E, R | SocketServer> =>
  Layer.effectDiscard(Effect.gen(function*() {
    const server = yield* SocketServer
    const address = server.address._tag === "UnixAddress"
      ? server.address.path
      : `${server.address.hostname}:${server.address.port}`
    yield* Effect.annotateLogs(Effect.logInfo(`Listening on: ${address}`), {
      package: "@effect/cluster",
      service: "Runner"
    })
  })).pipe(Layer.provideMerge(layer))

/**
 * @since 4.0.0
 * @category Layers
 */
export const layer: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | Runners.RpcClientProtocol
  | ShardingConfig
  | RpcSerialization.RpcSerialization
  | SocketServer
  | MessageStorage
  | RunnerStorage.RunnerStorage
  | RunnerHealth
> = RunnerServer.layerWithClients.pipe(
  withLogAddress,
  Layer.provide(RpcServer.layerProtocolSocketServer)
)

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerClientOnly: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  Runners.RpcClientProtocol | ShardingConfig | MessageStorage | RunnerStorage.RunnerStorage
> = RunnerServer.layerClientOnly
