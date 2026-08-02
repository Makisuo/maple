import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { Console, Effect, Option } from "effect"
import * as f from "../lib/flags"
import { printResult } from "../lib/output"
import { resolveRangeChecked, type Range } from "../core/time"
import * as Ops from "../core/operations"

import { formatWarehouseDateTime } from "@maple/query-engine"
const spanName = Flag.optional(Flag.string("span-name").pipe(Flag.withDescription("Filter by span name")))
const errorsOnly = Flag.boolean("errors").pipe(
	Flag.withDescription("Only include errored spans"),
	Flag.withDefault(false),
)
const bucket = Flag.optional(
	Flag.integer("bucket").pipe(Flag.withDescription("Bucket size in seconds (default 60)")),
)

export const timeseries = Command.make("timeseries", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	environment: f.environment,
	span: spanName,
	groupBy: Flag.choice("group-by", ["none", "service", "span_name", "status_code", "http_method"]).pipe(
		Flag.withDescription("Group series by dimension"),
		Flag.withDefault("none"),
	),
	errors: errorsOnly,
	bucket,
}).pipe(
	Command.withDescription(
		"Time-bucketed trace metrics (count, latency quantiles, error rate, apdex emitted per bucket)",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.tracesTimeseries({
				range,
				service: Option.getOrUndefined(a.service),
				spanName: Option.getOrUndefined(a.span),
				groupBy: a.groupBy,
				errorsOnly: a.errors,
				environment: Option.getOrUndefined(a.environment),
				bucketSeconds: Option.getOrUndefined(a.bucket),
			})
			yield* printResult(result)
		}),
	),
)

export const breakdown = Command.make("breakdown", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	environment: f.environment,
	span: spanName,
	groupBy: Flag.choice("group-by", ["service", "span_name", "status_code", "http_method"]).pipe(
		Flag.withDescription("Group results by dimension"),
		Flag.withDefault("span_name"),
	),
	errors: errorsOnly,
	limit: f.limit,
}).pipe(
	Command.withDescription("Top-N trace breakdown by dimension (service, span, status code, http method)"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.tracesBreakdown({
				range,
				service: Option.getOrUndefined(a.service),
				spanName: Option.getOrUndefined(a.span),
				groupBy: a.groupBy,
				errorsOnly: a.errors,
				environment: Option.getOrUndefined(a.environment),
				limit: a.limit,
			})
			yield* printResult(result)
		}),
	),
)

const win = 30 * 60 * 1000

export const compare = Command.make("compare", {
	around: Flag.optional(
		Flag.string("around").pipe(
			Flag.withDescription("Compare the 30m before vs after this UTC time (YYYY-MM-DD HH:mm:ss)"),
		),
	),
	currentStart: Flag.optional(Flag.string("current-start")),
	currentEnd: Flag.optional(Flag.string("current-end")),
	previousStart: Flag.optional(Flag.string("previous-start")),
	previousEnd: Flag.optional(Flag.string("previous-end")),
	environment: f.environment,
}).pipe(
	Command.withDescription("Compare service health between two time windows (regression detection)"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const around = Option.getOrUndefined(a.around)
			let current: Range
			let previous: Range

			if (around) {
				const t = Date.parse(`${around.slice(0, 19).replace(" ", "T")}Z`)
				if (Number.isNaN(t)) {
					yield* Console.error("--around must be a UTC timestamp 'YYYY-MM-DD HH:mm:ss'")
					return
				}
				current = { startTime: formatWarehouseDateTime(t), endTime: formatWarehouseDateTime(t + win) }
				previous = {
					startTime: formatWarehouseDateTime(t - win),
					endTime: formatWarehouseDateTime(t),
				}
			} else {
				const cs = Option.getOrUndefined(a.currentStart)
				const ce = Option.getOrUndefined(a.currentEnd)
				const ps = Option.getOrUndefined(a.previousStart)
				const pe = Option.getOrUndefined(a.previousEnd)
				if (!cs || !ce || !ps || !pe) {
					yield* Console.error(
						"Provide --around, or all of --current-start --current-end --previous-start --previous-end",
					)
					return
				}
				current = { startTime: cs, endTime: ce }
				previous = { startTime: ps, endTime: pe }
			}

			const result = yield* Ops.compareServiceOverview({
				current,
				previous,
				environment: Option.getOrUndefined(a.environment),
			})
			yield* printResult(result)
		}),
	),
)
