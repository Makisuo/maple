import { Effect } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { TimeRange } from "./types"
import type { TracesMetric } from "../query-engine"
import { escapeForSQL } from "./sql-utils"

export interface TopOperation {
  readonly name: string
  readonly value: number
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
    const svc = escapeForSQL(input.serviceName)
    const orgId = escapeForSQL(executor.orgId)

    // Build metric expression
    let metricExpr: string
    switch (input.metric) {
      case "count":
        metricExpr = "count()"
        break
      case "avg_duration":
        metricExpr = "avg(Duration) / 1000000"
        break
      case "p50_duration":
        metricExpr = "quantile(0.5)(Duration) / 1000000"
        break
      case "p95_duration":
        metricExpr = "quantile(0.95)(Duration) / 1000000"
        break
      case "p99_duration":
        metricExpr = "quantile(0.99)(Duration) / 1000000"
        break
      case "error_rate":
        metricExpr = "if(count() > 0, countIf(StatusCode = 'Error') * 100.0 / count(), 0)"
        break
      case "apdex":
        metricExpr = "if(count() > 0, round((countIf(Duration / 1000000 < 500) + countIf(Duration / 1000000 >= 500 AND Duration / 1000000 < 2000) * 0.5) / count(), 4), 0)"
        break
      default:
        metricExpr = "count()"
    }

    const sql = `
      SELECT
        SpanName as name,
        ${metricExpr} as value
      FROM traces
      WHERE OrgId = '${orgId}'
        AND ServiceName = '${svc}'
        AND Timestamp >= parseDateTimeBestEffort('${escapeForSQL(input.timeRange.startTime)}')
        AND Timestamp <= parseDateTimeBestEffort('${escapeForSQL(input.timeRange.endTime)}')
      GROUP BY name
      ORDER BY value DESC
      LIMIT ${limit}
      FORMAT JSON
    `

    const rows = yield* executor.sqlQuery(sql)
    return rows.map((r: any): TopOperation => ({
      name: r.name,
      value: Number(r.value),
    }))
  })
