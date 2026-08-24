import { useMemo, useState } from "react"

import { SessionViews, type SessionView } from "@/components/agent-sessions/session-detail/session-views"
import { buildAgentSessionFixture } from "@/lab/agent-session-fixture"
import { buildSessionSummary } from "@/lib/agent-sessions/session-summary"
import { buildSessionTurns } from "@/lib/agent-sessions/session-turns"

/**
 * The session detail page's three views over a fixture — the fastest way to
 * eyeball the Overview, the waterfall and the flow graph without a warehouse.
 *
 * The page's own scroller is a `PageLayout.ScrollArea`, which is where the
 * views' sticky control bar pins; the plain `overflow-auto` column here stands
 * in for it, so what scrolls and what sticks reads the same as on the page.
 */
export function AgentSessionLab({ initialView }: { initialView?: SessionView }) {
	const spans = useMemo(() => buildAgentSessionFixture(), [])
	const turns = useMemo(() => buildSessionTurns(spans), [spans])
	const summary = useMemo(() => buildSessionSummary({ spans, turns }), [spans, turns])

	const [view, setView] = useState<SessionView>(initialView ?? "overview")
	const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>(undefined)

	return (
		<div className="flex h-screen flex-col bg-background">
			<div className="shrink-0 border-border border-b px-4 py-3">
				<h1 className="font-semibold text-sm">{summary.title ?? "Agent session"}</h1>
				<p className="text-muted-foreground text-xs">
					{summary.spanCount} spans · {turns.length} turns
					{selectedSpanId !== undefined && ` · selected ${selectedSpanId}`}
				</p>
			</div>
			{/* The same slot and the same classes `PageLayout.ScrollArea` carries:
			    the waterfall's virtualizer finds its scroller by that attribute, so
			    a stand-in without it silently takes the fallback path and the view
			    behaves differently here than on the page. */}
			<div data-slot="page-scroll-area" className="flex min-h-0 flex-1 flex-col overflow-auto px-4">
				<div className="flex min-h-64 shrink-0 grow flex-col">
					<SessionViews
						view={view}
						onViewChange={setView}
						turns={turns}
						summary={summary}
						selectedSpanId={selectedSpanId}
						onSelectSpan={setSelectedSpanId}
					/>
				</div>
			</div>
		</div>
	)
}
