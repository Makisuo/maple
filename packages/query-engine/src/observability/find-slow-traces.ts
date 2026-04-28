import { Array as Arr, Effect, Option, pipe } from "effect"
import { TraceId } from "@maple/domain"
import type { TracesDurationStatsOutput } from "@maple/domain/tinybird"
import { Schema } from "effect"
import { TinybirdExecutor } from "./TinybirdExecutor"
import type { FindSlowTracesInput, FindSlowTracesOutput, SpanResult } from "./types"
import { escapeForSQL } from "./sql-utils"

/**
 * Returns the slowest root spans in a time range, ordered by Duration DESC at
 * the database. Previously this fetched 500 rows from the `list_traces` pipe
 * (sorted by recency) and sorted them in JS, which both over-fetched and
 * returned the wrong page when the actual slowest traces were older than the
 * 500 most-recent.
 */
export const findSlowTraces = Effect.fn("Observability.findSlowTraces")(function* (
	input: FindSlowTracesInput,
) {
	const executor = yield* TinybirdExecutor
	const limit = input.limit ?? 10

	yield* Effect.annotateCurrentSpan("service", input.service ?? "all")

	const esc = escapeForSQL

	const conditions: string[] = [
		`OrgId = '${esc(executor.orgId)}'`,
		`Timestamp >= parseDateTimeBestEffort('${esc(input.timeRange.startTime)}')`,
		`Timestamp <= parseDateTimeBestEffort('${esc(input.timeRange.endTime)}')`,
		`ParentSpanId = ''`,
		...pipe(
			[
				input.service ? Option.some(`ServiceName = '${esc(input.service)}'`) : Option.none(),
				input.environment
					? Option.some(
							`ResourceAttributes['deployment.environment'] = '${esc(input.environment)}'`,
						)
					: Option.none(),
			],
			Arr.getSomes,
		),
	]

	const sql = `
      SELECT
        TraceId as traceId,
        SpanName as spanName,
        ServiceName as serviceName,
        Duration / 1000000 as durationMs,
        StatusCode as statusCode,
        toString(ResourceAttributes) as resourceAttributesStr,
        toString(Timestamp) as timestamp
      FROM traces
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY Duration DESC
      LIMIT ${limit}
      FORMAT JSON
    `

	interface SlowTraceRow {
		readonly traceId: string
		readonly spanName: string
		readonly serviceName: string
		readonly durationMs: number
		readonly statusCode: string
		readonly resourceAttributesStr: string
		readonly timestamp: string
	}

	const [rows, statsResult] = yield* Effect.all(
		[
			executor.sqlQuery<SlowTraceRow>(sql, { profile: "list" }),
			executor.query<TracesDurationStatsOutput>(
				"traces_duration_stats",
				{
					start_time: input.timeRange.startTime,
					end_time: input.timeRange.endTime,
					...(input.service && { service: input.service }),
				},
				{ profile: "aggregation" },
			),
		],
		{ concurrency: "unbounded" },
	)

	const traces: ReadonlyArray<SpanResult> = pipe(
		rows,
		Arr.map(
			(r): SpanResult => ({
				traceId: Schema.decodeSync(TraceId)(r.traceId),
				spanId: null,
				spanName: r.spanName,
				serviceName: r.serviceName,
				durationMs: Number(r.durationMs),
				statusCode: r.statusCode,
				statusMessage: "",
				attributes: {},
				resourceAttributes: {},
				timestamp: r.timestamp,
			}),
		),
	)

	const rawStats = rows.length > 0 ? statsResult.data[0] : undefined

	return {
		timeRange: input.timeRange,
		stats: rawStats
			? {
					p50Ms: Number(rawStats.p50DurationMs ?? 0),
					p95Ms: Number(rawStats.p95DurationMs ?? 0),
					minMs: Number(rawStats.minDurationMs ?? 0),
					maxMs: Number(rawStats.maxDurationMs ?? 0),
				}
			: null,
		traces,
	} satisfies FindSlowTracesOutput
})
