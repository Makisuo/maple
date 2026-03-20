import { HttpServerRequest } from "effect/unstable/http"
import { Effect, Layer, Option, ServiceMap } from "effect"
import type { TenantContext } from "@/services/AuthService"
import { McpTenantError } from "@/mcp/tools/types"
import { resolveMcpTenantContext } from "./resolve-tenant"

export class CurrentTenantContext extends ServiceMap.Service<
  CurrentTenantContext,
  TenantContext
>()("CurrentTenantContext") {}

export const CurrentTenantContextLive = (tenant: TenantContext) =>
  Layer.succeed(CurrentTenantContext)(tenant)

export const resolveToolTenantContext = Effect.gen(function* () {
  const currentTenant = yield* Effect.serviceOption(CurrentTenantContext)
  if (Option.isSome(currentTenant)) {
    return currentTenant.value
  }

  const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
  if (Option.isNone(request)) {
    return yield* Effect.fail(
      new McpTenantError({
        message: "No tenant context available for tool execution",
      }),
    )
  }

  const nativeRequest = yield* HttpServerRequest.toWeb(request.value)
  return yield* resolveMcpTenantContext(nativeRequest)
}).pipe(
  Effect.mapError((error) =>
    error instanceof McpTenantError
      ? error
      : new McpTenantError({
          message: error instanceof Error ? error.message : String(error),
        }),
  ),
)
