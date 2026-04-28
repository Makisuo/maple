import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import * as Flag from "effect/unstable/cli/Flag"
import { Console, Effect, Option } from "effect"
import * as flags from "../shared-flags"
import { MapleClient } from "../../services/MapleClient"
import { printJson } from "../../services/Formatter"
import { resolveTimeRange } from "../../lib/time"

export const values = Command.make("values", {
	key: Argument.string("key").pipe(Argument.withDescription("The attribute key to get values for")),
	scope: Flag.choice("scope", ["span", "resource"]).pipe(
		Flag.withDescription("Attribute scope"),
		Flag.withDefault("span"),
	),
	service: flags.service,
	since: flags.since,
	start: flags.start,
	end: flags.end,
	limit: flags.limit,
	json: flags.json,
}).pipe(
	Command.withDescription("Get values for a specific attribute key"),
	Command.withHandler(
		Effect.fnUntraced(function* (f) {
			const client = yield* MapleClient
			const { startTime, endTime } = resolveTimeRange({ since: f.since, start: f.start, end: f.end })

			const result = yield* client.callTool("explore_attributes", {
				source: "traces",
				scope: f.scope,
				key: f.key,
				start_time: startTime,
				end_time: endTime,
				...(Option.isSome(f.service) && { service_name: f.service.value }),
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
