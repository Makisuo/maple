import * as Command from "effect/unstable/cli/Command"
import { Console, Effect, Option } from "effect"
import * as flags from "../shared-flags"
import { MapleClient } from "../../services/MapleClient"
import { printJson } from "../../services/Formatter"
import { resolveTimeRange } from "../../lib/time"

export const map = Command.make("map", {
	service: flags.service,
	since: flags.since,
	start: flags.start,
	end: flags.end,
	environment: flags.environment,
	json: flags.json,
}).pipe(
	Command.withDescription("Show service-to-service dependency map"),
	Command.withHandler(
		Effect.fnUntraced(function* (f) {
			const client = yield* MapleClient
			const { startTime, endTime } = resolveTimeRange({ since: f.since, start: f.start, end: f.end })

			const result = yield* client.callTool("service_map", {
				start_time: startTime,
				end_time: endTime,
				...(Option.isSome(f.service) && { service_name: f.service.value }),
				...(Option.isSome(f.environment) && { environment: f.environment.value }),
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
