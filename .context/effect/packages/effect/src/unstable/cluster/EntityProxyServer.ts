/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type * as HttpApi from "../httpapi/HttpApi.ts"
import * as HttpApiBuilder from "../httpapi/HttpApiBuilder.ts"
import type * as HttpApiGroup from "../httpapi/HttpApiGroup.ts"
import type * as Rpc from "../rpc/Rpc.ts"
import type * as Entity from "./Entity.ts"
import type { Sharding } from "./Sharding.ts"

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerHttpApi = <
  ApiId extends string,
  Groups extends HttpApiGroup.Any,
  Name extends HttpApiGroup.Name<Groups>,
  Type extends string,
  Rpcs extends Rpc.Any
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  name: Name,
  entity: Entity.Entity<Type, Rpcs>
): Layer.Layer<HttpApiGroup.ApiGroup<ApiId, Name>, never, Sharding | Rpc.ServicesServer<Rpcs>> =>
  HttpApiBuilder.group(
    api,
    name,
    Effect.fnUntraced(function*(handlers_) {
      const client = yield* entity.client
      let handlers = handlers_
      for (const parentRpc_ of entity.protocol.requests.values()) {
        const parentRpc = parentRpc_ as any as Rpc.AnyWithProps
        handlers = handlers
          .handle(
            parentRpc._tag as any,
            (({ path, payload }: { path: { entityId: string }; payload: any }) =>
              (client(path.entityId) as any as Record<string, (p: any) => Effect.Effect<any>>)[parentRpc._tag](
                payload
              ).pipe(
                Effect.tapDefect(Effect.logError),
                Effect.annotateLogs({
                  module: "EntityProxyServer",
                  entity: entity.type,
                  entityId: path.entityId,
                  method: parentRpc._tag
                })
              )) as any
          )
          .handle(
            `${parentRpc._tag}Discard` as any,
            (({ path, payload }: { path: { entityId: string }; payload: any }) =>
              (client(path.entityId) as any as Record<string, (p: any, o: {}) => Effect.Effect<any>>)[parentRpc._tag](
                payload,
                { discard: true }
              ).pipe(
                Effect.tapDefect(Effect.logError),
                Effect.annotateLogs({
                  module: "EntityProxyServer",
                  entity: entity.type,
                  entityId: path.entityId,
                  method: `${parentRpc._tag}Discard`
                })
              )) as any
          ) as any
      }
      return handlers as HttpApiBuilder.Handlers<never, never>
    })
  )

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerRpcHandlers = <
  const Type extends string,
  Rpcs extends Rpc.Any
>(
  entity: Entity.Entity<Type, Rpcs>
): Layer.Layer<RpcHandlers<Rpcs, Type>, never, Sharding | Rpc.ServicesServer<Rpcs>> =>
  Layer.effectServices(Effect.gen(function*() {
    const services = yield* Effect.services<never>()
    const client = yield* entity.client
    const handlers = new Map<string, Rpc.Handler<string>>()
    for (const parentRpc_ of entity.protocol.requests.values()) {
      const parentRpc = parentRpc_ as any as Rpc.AnyWithProps
      const tag = `${entity.type}.${parentRpc._tag}` as const
      const key = `effect/rpc/Rpc/${tag}`
      handlers.set(key, {
        services,
        tag,
        handler: ({ entityId, payload }: any) => (client(entityId) as any)[parentRpc._tag](payload) as any
      } as any)
      handlers.set(`${key}Discard`, {
        services,
        tag,
        handler: ({ entityId, payload }: any) =>
          (client(entityId) as any)[parentRpc._tag](payload, { discard: true }) as any
      } as any)
    }
    return ServiceMap.makeUnsafe(handlers)
  }))

/**
 * @since 4.0.0
 */
export type RpcHandlers<Rpcs extends Rpc.Any, Prefix extends string> = Rpcs extends Rpc.Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? Rpc.Handler<`${Prefix}.${_Tag}`> | Rpc.Handler<`${Prefix}.${_Tag}Discard`>
  : never
