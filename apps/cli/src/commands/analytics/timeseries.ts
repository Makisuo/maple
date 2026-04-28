import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { Console, Effect, Option } from "effect"
import * as flags from "../shared-flags"
import { MapleClient } from "../../services/MapleClient"
import { printJson } from "../../services/Formatter"
import { resolveTimeRange } from "../../lib/time"

export const timeseries = Command.make("timeseries", {
	source: Flag.choice("source", ["traces", "logs", "metrics"]).pipe(
		Flag.withDescription("Data source"),
		Flag.withDefault("traces"),
	),
	metric: Flag.string("metric").pipe(
		Flag.withDescription(
			"Metric: count, avg_duration, p50_duration, p95_duration, p99_duration, error_rate, apdex",
		),
		Flag.withDefault("count"),
	),
	service: flags.service,
	span: Flag.optional(Flag.string("span").pipe(Flag.withDescription("Filter by span name"))),
	groupBy: Flag.choice("group-by", ["service", "span_name", "status_code", "http_method", "none"]).pipe(
		Flag.withDescription("Group results by dimension"),
		Flag.withDefault("none"),
	),
	attr: flags.attr,
	since: flags.since,
	start: flags.start,
	end: flags.end,
	bucket: Flag.optional(Flag.integer("bucket").pipe(Flag.withDescription("Bucket size in seconds"))),
	json: flags.json,
}).pipe(
	Command.withDescription("Query time-bucketed metrics (count, latency, error rate, apdex)"),
	Command.withHandler(
		Effect.fnUntraced(function* (f) {
			const client = yield* MapleClient
			const { startTime, endTime } = resolveTimeRange({ since: f.since, start: f.start, end: f.end })

			const result = yield* client.callTool("query_data", {
				source: f.source,
				kind: "timeseries",
				metric: f.metric,
				group_by: f.groupBy,
				start_time: startTime,
				end_time: endTime,
				...(Option.isSome(f.service) && { service_name: f.service.value }),
				...(Option.isSome(f.span) && { span_name: f.span.value }),
				...(Option.isSome(f.bucket) && { bucket_seconds: f.bucket.value }),
				...(Option.isSome(f.attr) && {
					attribute_key: Object.keys(f.attr.value)[0],
					attribute_value: Object.values(f.attr.value)[0],
				}),
			})

			if (f.json) {
				yield* printJson(result.data ?? { text: result._text ?? result.text })
				return
			}

			const text = result._text ?? result.text
			if (text) {
				yield* Console.log(text)
			} else {
				yield* printJson(result.data ?? result)
			}
		}),
	),
)
