import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { TinybirdExecutor, ObservabilityError } from "@maple/query-engine/observability"
import { TinybirdService } from "./TinybirdService"
import { resolveMcpTenantContext } from "@/mcp/lib/resolve-tenant"
import type { TenantContext } from "./AuthService"

/**
 * Creates a TinybirdExecutor layer that resolves the tenant from the current
 * HTTP request and delegates to TinybirdService.
 *
 * Used by observability functions in @maple/query-engine/observability.
 */
export const makeTinybirdExecutorFromTenant = (tenant: TenantContext) =>
  Layer.effect(
    TinybirdExecutor,
    Effect.gen(function* () {
      const tinybird = yield* TinybirdService

      return TinybirdExecutor.of({
        orgId: tenant.orgId,
        query: (pipe, params) =>
          tinybird.query(tenant, { pipe, params }).pipe(
            Effect.map((response) => ({ data: response.data as any[] })),
            Effect.mapError(
              (error) => new ObservabilityError({ message: error.message, pipe }),
            ),
          ),
        sqlQuery: (sql) =>
          tinybird.sqlQuery(tenant, sql).pipe(
            Effect.mapError(
              (error) => new ObservabilityError({ message: error.message }),
            ),
          ),
      })
    }),
  )
