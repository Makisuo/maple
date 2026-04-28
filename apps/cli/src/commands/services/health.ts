import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import { Console, Effect } from "effect"
import * as flags from "../shared-flags"
import { MapleClient } from "../../services/MapleClient"
import { printJson } from "../../services/Formatter"
import { resolveTimeRange } from "../../lib/time"

export const health = Command.make("health", {
	serviceName: Argument.string("service-name").pipe(Argument.withDescription("Service to diagnose")),
	since: flags.since,
	start: flags.start,
	end: flags.end,
	json: flags.json,
}).pipe(
	Command.withDescription("Deep health check for a specific service"),
	Command.withHandler(
		Effect.fnUntraced(function* (f) {
			const client = yield* MapleClient
			const { startTime, endTime } = resolveTimeRange({ since: f.since, start: f.start, end: f.end })

			const result = yield* client.callTool("diagnose_service", {
				service_name: f.serviceName,
				start_time: startTime,
				end_time: endTime,
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
