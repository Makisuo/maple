import { HttpServerRequest } from "effect/unstable/http"
import type { TinybirdPipe } from "@maple/domain"
import { Effect } from "effect"
import { resolveMcpTenantContext } from "@/mcp/lib/resolve-tenant"
import { McpTenantError, McpQueryError } from "@/mcp/tools/types"
import { TinybirdService } from "@/services/TinybirdService"
import type { TenantContext } from "@/services/AuthService"

const resolveTenant = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const nativeReq = yield* HttpServerRequest.toWeb(req)
  return yield* resolveMcpTenantContext(nativeReq)
}).pipe(
  Effect.mapError((error: unknown) =>
    new McpTenantError({
      message:
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "message" in error
            ? String(error.message)
            : String(error),
    }),
  ),
)

export const queryTinybird = <T = any>(
  pipe: TinybirdPipe,
  params?: Record<string, unknown>,
)=>
  Effect.gen(function* () {
    const tenant = yield* resolveTenant
    const service = yield* TinybirdService
    const response = yield* service.query(tenant, { pipe, params }).pipe(
      Effect.mapError(
        (error) =>
          new McpQueryError({
            message: error.message,
            pipe,
          }),
      ),
    )

    return { data: response.data as T[] }
  })
