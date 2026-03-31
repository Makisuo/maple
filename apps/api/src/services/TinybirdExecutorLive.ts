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
        query: <T>(pipe: string, params: Record<string, unknown>) =>
          tinybird.query(tenant, { pipe: pipe as any, params }).pipe(
            Effect.map((response) => ({ data: response.data as unknown as ReadonlyArray<T> })),
            Effect.mapError(
              (error) => new ObservabilityError({ message: error.message, pipe }),
            ),
          ),
        sqlQuery: <T>(sql: string) =>
          tinybird.sqlQuery(tenant, sql).pipe(
            Effect.map((rows) => rows as unknown as ReadonlyArray<T>),
            Effect.mapError(
              (error) => new ObservabilityError({ message: error.message }),
            ),
          ),
      })
    }),
  )
