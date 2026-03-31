import { Array as Arr, Effect, pipe } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { TimeRange } from "./types"
import type { TracesMetric } from "../query-engine"
import { escapeForSQL } from "./sql-utils"

export interface TopOperation {
  readonly name: string
  readonly value: number
}

const METRIC_EXPRESSIONS: Record<string, string> = {
  count: "count()",
  avg_duration: "avg(Duration) / 1000000",
  p50_duration: "quantile(0.5)(Duration) / 1000000",
  p95_duration: "quantile(0.95)(Duration) / 1000000",
  p99_duration: "quantile(0.99)(Duration) / 1000000",
  error_rate: "if(count() > 0, countIf(StatusCode = 'Error') * 100.0 / count(), 0)",
  apdex: "if(count() > 0, round((countIf(Duration / 1000000 < 500) + countIf(Duration / 1000000 >= 500 AND Duration / 1000000 < 2000) * 0.5) / count(), 4), 0)",
}

export const topOperations = (input: {
  readonly serviceName: string
  readonly metric: TracesMetric
  readonly timeRange: TimeRange
  readonly limit?: number
}): Effect.Effect<ReadonlyArray<TopOperation>, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor
    const limit = input.limit ?? 20
    const esc = escapeForSQL
    const metricExpr = METRIC_EXPRESSIONS[input.metric] ?? "count()"

    const sql = `
      SELECT
        SpanName as name,
        ${metricExpr} as value
      FROM traces
      WHERE OrgId = '${esc(executor.orgId)}'
        AND ServiceName = '${esc(input.serviceName)}'
        AND Timestamp >= parseDateTimeBestEffort('${esc(input.timeRange.startTime)}')
        AND Timestamp <= parseDateTimeBestEffort('${esc(input.timeRange.endTime)}')
      GROUP BY name
      ORDER BY value DESC
      LIMIT ${limit}
      FORMAT JSON
    `

    interface TopOpRow { readonly name: string; readonly value: number }
    const rows = yield* executor.sqlQuery<TopOpRow>(sql)
    return pipe(
      rows,
      Arr.map((r): TopOperation => ({ name: r.name, value: Number(r.value) })),
    )
  })
