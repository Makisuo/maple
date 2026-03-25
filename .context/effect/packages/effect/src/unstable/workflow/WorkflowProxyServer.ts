/**
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type * as HttpApi from "../httpapi/HttpApi.ts"
import * as HttpApiBuilder from "../httpapi/HttpApiBuilder.ts"
import type * as HttpApiGroup from "../httpapi/HttpApiGroup.ts"
import type * as Rpc from "../rpc/Rpc.ts"
import type * as Workflow from "./Workflow.ts"
import type { WorkflowEngine } from "./WorkflowEngine.ts"

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerHttpApi = <
  ApiId extends string,
  Groups extends HttpApiGroup.Any,
  Name extends HttpApiGroup.Name<Groups>,
  const Workflows extends NonEmptyReadonlyArray<Workflow.Any>
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  name: Name,
  workflows: Workflows
): Layer.Layer<
  HttpApiGroup.ApiGroup<ApiId, Name>,
  never,
  WorkflowEngine | Workflow.RequirementsHandler<Workflows[number]>
> =>
  HttpApiBuilder.group(
    api,
    name,
    Effect.fnUntraced(function*(handlers_) {
      let handlers = handlers_ as any
      for (const workflow_ of workflows) {
        const workflow = workflow_ as Workflow.AnyWithProps
        handlers = handlers
          .handle(
            workflow.name as any,
            ({ payload }: { payload: any }) =>
              workflow.execute(payload).pipe(
                Effect.tapDefect(Effect.logError),
                Effect.annotateLogs({
                  module: "WorkflowProxyServer",
                  method: workflow.name
                })
              )
          )
          .handle(
            workflow.name + "Discard" as any,
            ({ payload }: { payload: any }) =>
              workflow.execute(payload, { discard: true } as any).pipe(
                Effect.tapDefect(Effect.logError),
                Effect.annotateLogs({
                  module: "WorkflowProxyServer",
                  method: workflow.name + "Discard"
                })
              )
          )
          .handle(
            workflow.name + "Resume" as any,
            ({ payload }: { payload: any }) =>
              workflow.resume(payload.executionId).pipe(
                Effect.tapDefect(Effect.logError),
                Effect.annotateLogs({
                  module: "WorkflowProxyServer",
                  method: workflow.name + "Resume"
                })
              )
          )
      }
      return handlers as HttpApiBuilder.Handlers<never, never>
    })
  )

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerRpcHandlers = <
  const Workflows extends NonEmptyReadonlyArray<Workflow.Any>,
  const Prefix extends string = ""
>(workflows: Workflows, options?: {
  readonly prefix?: Prefix
}): Layer.Layer<
  RpcHandlers<Workflows[number], Prefix>,
  never,
  WorkflowEngine | Workflow.RequirementsHandler<Workflows[number]>
> =>
  Layer.effectServices(Effect.gen(function*() {
    const services = yield* Effect.services<never>()
    const prefix = options?.prefix ?? ""
    const handlers = new Map<string, Rpc.Handler<string>>()
    for (const workflow_ of workflows) {
      const workflow = workflow_ as Workflow.AnyWithProps
      const tag = `${prefix}${workflow.name}`
      const tagDiscard = `${tag}Discard`
      const tagResume = `${tag}Resume`
      const key = `effect/rpc/Rpc/${tag}`
      const keyDiscard = `${key}Discard`
      const keyResume = `${key}Resume`
      handlers.set(key, {
        services,
        tag,
        handler: (payload: any) => workflow.execute(payload) as any
      } as any)
      handlers.set(keyDiscard, {
        services,
        tag: tagDiscard,
        handler: (payload: any) => workflow.execute(payload, { discard: true } as any) as any
      } as any)
      handlers.set(keyResume, {
        services,
        tag: tagResume,
        handler: (payload: any) => workflow.resume(payload.executionId) as any
      } as any)
    }
    return ServiceMap.makeUnsafe(handlers)
  }))

/**
 * @since 4.0.0
 */
export type RpcHandlers<Workflows extends Workflow.Any, Prefix extends string> = Workflows extends Workflow.Workflow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error
> ? Rpc.Handler<`${Prefix}${_Name}`> | Rpc.Handler<`${Prefix}${_Name}Discard`> | Rpc.Handler<`${Prefix}${_Name}Resume`>
  : never
