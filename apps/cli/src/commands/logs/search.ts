import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { Console, Effect, Option } from "effect"
import * as flags from "../shared-flags"
import { MapleClient } from "../../services/MapleClient"
import { printJson } from "../../services/Formatter"
import { resolveTimeRange } from "../../lib/time"

export const search = Command.make("search", {
	service: flags.service,
	severity: Flag.optional(
		Flag.choice("severity", ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]).pipe(
			Flag.withDescription("Filter by log severity"),
		),
	),
	query: Flag.optional(
		Flag.string("query").pipe(Flag.withAlias("q"), Flag.withDescription("Search text in log body")),
	),
	traceId: Flag.optional(Flag.string("trace-id").pipe(Flag.withDescription("Filter logs by trace ID"))),
	since: flags.since,
	start: flags.start,
	end: flags.end,
	limit: flags.limit,
	offset: flags.offset,
	json: flags.json,
}).pipe(
	Command.withDescription("Search logs with filtering"),
	Command.withHandler(
		Effect.fnUntraced(function* (f) {
			const client = yield* MapleClient
			const { startTime, endTime } = resolveTimeRange({ since: f.since, start: f.start, end: f.end })

			const result = yield* client.callTool("search_logs", {
				start_time: startTime,
				end_time: endTime,
				...(Option.isSome(f.service) && { service: f.service.value }),
				...(Option.isSome(f.severity) && { severity: f.severity.value }),
				...(Option.isSome(f.query) && { search: f.query.value }),
				...(Option.isSome(f.traceId) && { trace_id: f.traceId.value }),
				offset: f.offset,
				limit: f.limit,
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
