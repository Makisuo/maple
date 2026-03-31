import { Effect, Schema, ServiceMap } from "effect"
import type { TinybirdPipe } from "@maple/domain/tinybird-pipes"

export class ObservabilityError extends Schema.TaggedErrorClass<ObservabilityError>()(
  "ObservabilityError",
  {
    message: Schema.String,
    pipe: Schema.optional(Schema.String),
  },
) {}

export interface TinybirdExecutorShape {
  /** The org ID for the current tenant — needed for raw SQL queries. */
  readonly orgId: string

  readonly query: <T = any>(
    pipe: TinybirdPipe,
    params: Record<string, unknown>,
  ) => Effect.Effect<{ data: ReadonlyArray<T> }, ObservabilityError>

  /** Execute raw ClickHouse SQL. The SQL MUST include an OrgId filter. */
  readonly sqlQuery: (
    sql: string,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, ObservabilityError>
}

export class TinybirdExecutor extends ServiceMap.Service<TinybirdExecutor, TinybirdExecutorShape>()(
  "TinybirdExecutor",
) {}
