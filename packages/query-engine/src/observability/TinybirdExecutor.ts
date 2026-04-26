import { Effect, Schema, Context } from "effect"
import type { TinybirdPipe } from "@maple/domain/tinybird-pipes"

export class ObservabilityError extends Schema.TaggedErrorClass<ObservabilityError>()(
  "@maple/query-engine/errors/ObservabilityError",
  {
    message: Schema.String,
    pipe: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect),
  },
) {}

/**
 * Subset of ClickHouse settings that Tinybird allows on `/v0/sql`.
 * Row/byte caps (`max_rows_to_read`, `max_result_rows`, `max_bytes_to_read`)
 * are restricted by Tinybird and intentionally absent.
 */
export type ExecutorQuerySettings = {
  maxExecutionTime?: number
  maxMemoryUsage?: number
  maxThreads?: number
}

export type ExecutorQueryProfile = "discovery" | "list" | "aggregation" | "explain" | "unbounded"

export type ExecutorQueryOptions = {
  profile?: ExecutorQueryProfile
  settings?: ExecutorQuerySettings
}

export interface TinybirdExecutorShape {
  /** The org ID for the current tenant — needed for raw SQL queries. */
  readonly orgId: string

  readonly query: <T = any>(
    pipe: TinybirdPipe,
    params: Record<string, unknown>,
    options?: ExecutorQueryOptions,
  ) => Effect.Effect<{ data: ReadonlyArray<T> }, ObservabilityError>

  /** Execute raw ClickHouse SQL. The SQL MUST include an OrgId filter. */
  readonly sqlQuery: <T = Record<string, unknown>>(
    sql: string,
    options?: ExecutorQueryOptions,
  ) => Effect.Effect<ReadonlyArray<T>, ObservabilityError>
}

export class TinybirdExecutor extends Context.Service<TinybirdExecutor, TinybirdExecutorShape>()(
  "TinybirdExecutor",
) {}
