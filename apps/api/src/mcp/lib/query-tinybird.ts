import type { TinybirdPipe } from "@maple/domain"
import { Effect } from "effect"
import { McpTenantError, McpQueryError } from "@/mcp/tools/types"
import { TinybirdService } from "@/services/TinybirdService"
import { resolveToolTenantContext } from "./current-tenant-context"

const resolveTenant = resolveToolTenantContext.pipe(
  Effect.mapError((error: unknown) =>
    error instanceof McpTenantError
      ? error
      : new McpTenantError({
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
