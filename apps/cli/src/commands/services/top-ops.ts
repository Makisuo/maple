import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import * as Flag from "effect/unstable/cli/Flag"
import { Console, Effect } from "effect"
import * as flags from "../shared-flags"
import { MapleClient } from "../../services/MapleClient"
import { printJson } from "../../services/Formatter"
import { resolveTimeRange } from "../../lib/time"

export const topOps = Command.make("top-ops", {
	serviceName: Argument.string("service-name").pipe(
		Argument.withDescription("Service to get top operations for"),
	),
	metric: Flag.choice("metric", ["count", "error_rate", "avg_duration", "p95_duration"]).pipe(
		Flag.withDescription("Sort by metric"),
		Flag.withDefault("count"),
	),
	since: flags.since,
	start: flags.start,
	end: flags.end,
	limit: flags.limit,
	json: flags.json,
}).pipe(
	Command.withDescription("Get top operations/endpoints for a service"),
	Command.withHandler(
		Effect.fnUntraced(function* (f) {
			const client = yield* MapleClient
			const { startTime, endTime } = resolveTimeRange({ since: f.since, start: f.start, end: f.end })

			const result = yield* client.callTool("get_service_top_operations", {
				service_name: f.serviceName,
				metric: f.metric,
				start_time: startTime,
				end_time: endTime,
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
