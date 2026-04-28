import * as Command from "effect/unstable/cli/Command"
import { Console, Effect, Option } from "effect"
import * as flags from "../shared-flags"
import { MapleClient } from "../../services/MapleClient"
import { printJson } from "../../services/Formatter"
import { resolveTimeRange } from "../../lib/time"

export const list = Command.make("list", {
	service: flags.service,
	since: flags.since,
	start: flags.start,
	end: flags.end,
	environment: flags.environment,
	limit: flags.limit,
	json: flags.json,
}).pipe(
	Command.withDescription("List errors grouped by type with counts"),
	Command.withHandler(
		Effect.fnUntraced(function* (f) {
			const client = yield* MapleClient
			const { startTime, endTime } = resolveTimeRange({ since: f.since, start: f.start, end: f.end })

			const result = yield* client.callTool("find_errors", {
				start_time: startTime,
				end_time: endTime,
				...(Option.isSome(f.service) && { service: f.service.value }),
				...(Option.isSome(f.environment) && { environment: f.environment.value }),
				limit: f.limit,
			})

			if (f.json) {
				yield* printJson(result.data ?? { text: result._text ?? result.text })
				return
			}

			// Use the MCP's pre-formatted text output
			const text = result._text ?? result.text
			if (text) {
				yield* Console.log(text)
			} else {
				yield* printJson(result.data ?? result)
			}
		}),
	),
)
