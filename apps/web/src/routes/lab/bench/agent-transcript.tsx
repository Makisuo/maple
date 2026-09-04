import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { AgentTranscriptBench } from "@/lab/bench/agent-transcript-bench"

/** `?turns=` sizes the session; the default is big enough that an unbounded
 *  row shows up in the numbers without the page taking a minute to build.
 *  A number, not a string: the router JSON-parses search values, so `?turns=40`
 *  arrives as `40`. */
const searchSchema = Schema.Struct({ turns: Schema.optional(Schema.Number) })

const DEFAULT_TURNS = 40

export const Route = createFileRoute("/lab/bench/agent-transcript")({
	component: AgentTranscriptBenchRoute,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

function AgentTranscriptBenchRoute() {
	const { turns } = Route.useSearch()
	return (
		<AgentTranscriptBench
			turns={turns !== undefined && Number.isInteger(turns) && turns > 0 ? turns : DEFAULT_TURNS}
		/>
	)
}
