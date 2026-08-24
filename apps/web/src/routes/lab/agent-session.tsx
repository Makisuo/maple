import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { AgentSessionLab } from "@/lab/agent-session-lab"
import { isSessionView } from "@/components/agent-sessions/session-detail/session-views"

/** `?view=` so a view can be loaded cold, the way the real page loads one — the
 *  only way to see what a view does on its very first paint. */
const searchSchema = Schema.Struct({ view: Schema.optional(Schema.String) })

export const Route = createFileRoute("/lab/agent-session")({
	component: AgentSessionLabRoute,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

function AgentSessionLabRoute() {
	const { view } = Route.useSearch()
	return <AgentSessionLab initialView={view !== undefined && isSessionView(view) ? view : undefined} />
}
