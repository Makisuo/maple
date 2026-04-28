import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { Console, Effect, Option } from "effect"
import * as flags from "../shared-flags"
import { MapleClient } from "../../services/MapleClient"
import { printJson } from "../../services/Formatter"

export const compare = Command.make("compare", {
	around: Flag.optional(
		Flag.string("around").pipe(
			Flag.withDescription("Auto-generate 30min before/after comparison (YYYY-MM-DD HH:mm:ss)"),
		),
	),
	currentStart: Flag.optional(Flag.string("current-start")),
	currentEnd: Flag.optional(Flag.string("current-end")),
	previousStart: Flag.optional(Flag.string("previous-start")),
	previousEnd: Flag.optional(Flag.string("previous-end")),
	service: flags.service,
	environment: flags.environment,
	json: flags.json,
}).pipe(
	Command.withDescription("Compare system health between two time periods for regression detection"),
	Command.withHandler(
		Effect.fnUntraced(function* (f) {
			const client = yield* MapleClient

			const args: Record<string, unknown> = {}

			if (Option.isSome(f.around)) {
				args.around_time = f.around.value
			} else if (
				Option.isSome(f.currentStart) &&
				Option.isSome(f.currentEnd) &&
				Option.isSome(f.previousStart) &&
				Option.isSome(f.previousEnd)
			) {
				args.current_start = f.currentStart.value
				args.current_end = f.currentEnd.value
				args.previous_start = f.previousStart.value
				args.previous_end = f.previousEnd.value
			} else {
				yield* Console.error(
					"Provide --around or all four --current-start/end --previous-start/end flags",
				)
				return
			}

			if (Option.isSome(f.service)) args.service_name = f.service.value
			if (Option.isSome(f.environment)) args.environment = f.environment.value

			const result = yield* client.callTool("compare_periods", args)

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
