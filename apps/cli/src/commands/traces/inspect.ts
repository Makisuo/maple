import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import * as Flag from "effect/unstable/cli/Flag"
import { Console, Effect } from "effect"
import { MapleClient } from "../../services/MapleClient"
import { printJson } from "../../services/Formatter"

export const inspect = Command.make("inspect", {
	traceId: Argument.string("trace-id").pipe(Argument.withDescription("The trace ID to inspect")),
	json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)),
}).pipe(
	Command.withDescription("Inspect a trace with full span tree and logs"),
	Command.withHandler(
		Effect.fnUntraced(function* ({ traceId, json: jsonMode }) {
			const client = yield* MapleClient

			// Call inspect_trace MCP tool directly — it returns a formatted span tree
			const result = yield* client.callTool("inspect_trace", { trace_id: traceId })

			if (jsonMode) {
				yield* printJson(result.data ?? result)
				return
			}

			// The MCP tool provides pre-formatted text output
			const text = result._text ?? result.text
			if (text) {
				yield* Console.log(text)
			} else {
				yield* printJson(result.data ?? result)
			}
		}),
	),
)
