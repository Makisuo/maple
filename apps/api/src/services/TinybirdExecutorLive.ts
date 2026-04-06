import { Effect, Layer } from "effect"
import { TinybirdExecutor, ObservabilityError } from "@maple/query-engine/observability"
import { TinybirdService } from "./TinybirdService"
import type { TenantContext } from "./AuthService"

const truncateSql = (s: string, maxLen = 1000) =>
  s.length > maxLen ? s.slice(0, maxLen) + "...[truncated]" : s

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
            Effect.tap((response) =>
              Effect.annotateCurrentSpan("result.rowCount", response.data.length),
            ),
            Effect.mapError(
              (error) => new ObservabilityError({ message: error.message, pipe }),
            ),
            Effect.withSpan("TinybirdExecutor.query", {
              attributes: { pipe, orgId: tenant.orgId },
            }),
          ),
        sqlQuery: <T>(sql: string) =>
          tinybird.sqlQuery(tenant, sql).pipe(
            Effect.map((rows) => rows as unknown as ReadonlyArray<T>),
            Effect.tap((rows) =>
              Effect.annotateCurrentSpan("result.rowCount", rows.length),
            ),
            Effect.mapError(
              (error) => new ObservabilityError({ message: error.message }),
            ),
            Effect.withSpan("TinybirdExecutor.sqlQuery", {
              attributes: {
                "db.system": "clickhouse",
                orgId: tenant.orgId,
                "db.statement": truncateSql(sql),
              },
            }),
          ),
      })
    }),
  )
