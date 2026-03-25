/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import type { Scope } from "../../Scope.ts"
import * as HttpClient from "../http/HttpClient.ts"
import * as HttpClientRequest from "../http/HttpClientRequest.ts"
import * as HttpRouter from "../http/HttpRouter.ts"
import type * as HttpServer from "../http/HttpServer.ts"
import type { HttpServerRequest } from "../http/HttpServerRequest.ts"
import type { HttpServerResponse } from "../http/HttpServerResponse.ts"
import * as RpcClient from "../rpc/RpcClient.ts"
import * as RpcSerialization from "../rpc/RpcSerialization.ts"
import * as RpcServer from "../rpc/RpcServer.ts"
import * as Socket from "../socket/Socket.ts"
import type { MessageStorage } from "./MessageStorage.ts"
import type { RunnerHealth } from "./RunnerHealth.ts"
import * as Runners from "./Runners.ts"
import { RpcClientProtocol } from "./Runners.ts"
import * as RunnerServer from "./RunnerServer.ts"
import type { RunnerStorage } from "./RunnerStorage.ts"
import * as Sharding from "./Sharding.ts"
import type * as ShardingConfig from "./ShardingConfig.ts"

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerClientProtocolHttp = (options: {
  readonly path: string
  readonly https?: boolean | undefined
}): Layer.Layer<
  RpcClientProtocol,
  never,
  RpcSerialization.RpcSerialization | HttpClient.HttpClient
> =>
  Layer.effect(RpcClientProtocol)(
    Effect.gen(function*() {
      const serialization = yield* RpcSerialization.RpcSerialization
      const client = yield* HttpClient.HttpClient
      const https = options.https ?? false
      return (address) => {
        const clientWithUrl = HttpClient.mapRequest(
          client,
          HttpClientRequest.prependUrl(`http${https ? "s" : ""}://${address.host}:${address.port}/${options.path}`)
        )
        return RpcClient.makeProtocolHttp(clientWithUrl).pipe(
          Effect.provideService(RpcSerialization.RpcSerialization, serialization)
        )
      }
    })
  )

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerClientProtocolHttpDefault: Layer.Layer<
  Runners.RpcClientProtocol,
  never,
  RpcSerialization.RpcSerialization | HttpClient.HttpClient
> = layerClientProtocolHttp({ path: "/" })

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerClientProtocolWebsocket = (options: {
  readonly path: string
  readonly https?: boolean | undefined
}): Layer.Layer<
  RpcClientProtocol,
  never,
  RpcSerialization.RpcSerialization | Socket.WebSocketConstructor
> =>
  Layer.effect(RpcClientProtocol)(
    Effect.gen(function*() {
      const serialization = yield* RpcSerialization.RpcSerialization
      const https = options.https ?? false
      const constructor = yield* Socket.WebSocketConstructor
      return Effect.fnUntraced(function*(address) {
        const socket = yield* Socket.makeWebSocket(
          `ws${https ? "s" : ""}://${address.host}:${address.port}/${options.path}`
        ).pipe(
          Effect.provideService(Socket.WebSocketConstructor, constructor)
        )
        return yield* RpcClient.makeProtocolSocket().pipe(
          Effect.provideService(Socket.Socket, socket),
          Effect.provideService(RpcSerialization.RpcSerialization, serialization)
        )
      })
    })
  )

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerClientProtocolWebsocketDefault: Layer.Layer<
  Runners.RpcClientProtocol,
  never,
  RpcSerialization.RpcSerialization | Socket.WebSocketConstructor
> = layerClientProtocolWebsocket({ path: "/" })

/**
 * @since 4.0.0
 * @category Http App
 */
export const toHttpEffect: Effect.Effect<
  Effect.Effect<HttpServerResponse, never, Scope | HttpServerRequest>,
  never,
  Scope | RpcSerialization.RpcSerialization | Sharding.Sharding | MessageStorage
> = Effect.gen(function*() {
  const handlers = yield* Layer.build(RunnerServer.layerHandlers)
  return yield* RpcServer.toHttpEffect(Runners.Rpcs, {
    spanPrefix: "RunnerServer",
    disableTracing: true
  }).pipe(Effect.provideServices(handlers))
})

/**
 * @since 4.0.0
 * @category Http App
 */
export const toHttpEffectWebsocket: Effect.Effect<
  Effect.Effect<HttpServerResponse, never, Scope | HttpServerRequest>,
  never,
  Scope | RpcSerialization.RpcSerialization | Sharding.Sharding | MessageStorage
> = Effect.gen(function*() {
  const handlers = yield* Layer.build(RunnerServer.layerHandlers)
  return yield* RpcServer.toHttpEffectWebsocket(Runners.Rpcs, {
    spanPrefix: "RunnerServer",
    disableTracing: true
  }).pipe(Effect.provideServices(handlers))
})

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerClient: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  ShardingConfig.ShardingConfig | Runners.RpcClientProtocol | MessageStorage | RunnerStorage | RunnerHealth
> = Sharding.layer.pipe(
  Layer.provideMerge(Runners.layerRpc)
)

/**
 * A HTTP layer for the `Runners` services, that adds a route to the provided
 * `HttpRouter`.
 *
 * @since 4.0.0
 * @category Layers
 */
export const layerHttpOptions = (options: {
  readonly path: HttpRouter.PathInput
}): Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | RunnerStorage
  | RunnerHealth
  | RpcSerialization.RpcSerialization
  | MessageStorage
  | ShardingConfig.ShardingConfig
  | Runners.RpcClientProtocol
  | HttpRouter.HttpRouter
> =>
  RunnerServer.layerWithClients.pipe(
    Layer.provide(RpcServer.layerProtocolHttp(options))
  )

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerWebsocketOptions = (options: {
  readonly path: HttpRouter.PathInput
}): Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | ShardingConfig.ShardingConfig
  | Runners.RpcClientProtocol
  | MessageStorage
  | RunnerStorage
  | RunnerHealth
  | RpcSerialization.RpcSerialization
  | HttpRouter.HttpRouter
> =>
  RunnerServer.layerWithClients.pipe(
    Layer.provide(RpcServer.layerProtocolWebsocket(options))
  )

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerHttp: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | RpcSerialization.RpcSerialization
  | ShardingConfig.ShardingConfig
  | HttpClient.HttpClient
  | HttpServer.HttpServer
  | MessageStorage
  | RunnerStorage
  | RunnerHealth
> = HttpRouter.serve(layerHttpOptions({ path: "/" })).pipe(
  Layer.provide(layerClientProtocolHttpDefault)
)

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerHttpClientOnly: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | RpcSerialization.RpcSerialization
  | ShardingConfig.ShardingConfig
  | HttpClient.HttpClient
  | MessageStorage
  | RunnerStorage
> = RunnerServer.layerClientOnly.pipe(
  Layer.provide(layerClientProtocolHttpDefault)
)

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerWebsocket: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | RpcSerialization.RpcSerialization
  | ShardingConfig.ShardingConfig
  | Socket.WebSocketConstructor
  | HttpServer.HttpServer
  | MessageStorage
  | RunnerStorage
  | RunnerHealth
> = HttpRouter.serve(layerWebsocketOptions({ path: "/" })).pipe(
  Layer.provide(layerClientProtocolWebsocketDefault)
)

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerWebsocketClientOnly: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | ShardingConfig.ShardingConfig
  | MessageStorage
  | RunnerStorage
  | RpcSerialization.RpcSerialization
  | Socket.WebSocketConstructor
> = RunnerServer.layerClientOnly.pipe(
  Layer.provide(layerClientProtocolWebsocketDefault)
)
