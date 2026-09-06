import { useMemo, useState } from "react"

import { SessionHeader } from "@/components/agent-sessions/session-detail/session-header"
import { SessionViews, type SessionView } from "@/components/agent-sessions/session-detail/session-views"
import { Toggle } from "@maple/ui/components/ui/toggle"
import { buildAgentSessionFixture, buildCaptureOffFixture } from "@/lab/agent-session-fixture"
import { buildSessionSummary } from "@/lib/agent-sessions/session-summary"
import { buildSessionTurns } from "@/lib/agent-sessions/session-turns"

/**
 * The session detail page's views over a fixture — the fastest way to eyeball
 * the Overview, the waterfall, the flow graph and the transcript without a
 * warehouse.
 *
 * The two toggles are the session-level states no fixture can be in and out of
 * at once: message capture off (the production default, which the transcript
 * has to survive as pure structure) and a truncated response (the END of the
 * session missing).
 *
 * The page's own scroller is a `PageLayout.ScrollArea`, which is where the
 * views' sticky control bar pins; the plain `overflow-auto` column here stands
 * in for it, so what scrolls and what sticks reads the same as on the page.
 */
export function AgentSessionLab({ initialView }: { initialView?: SessionView }) {
	const [captureOff, setCaptureOff] = useState(false)
	const [truncated, setTruncated] = useState(false)

	const spans = useMemo(
		() => (captureOff ? buildCaptureOffFixture() : buildAgentSessionFixture()),
		[captureOff],
	)
	const turns = useMemo(() => buildSessionTurns(spans), [spans])
	const summary = useMemo(() => buildSessionSummary({ spans, turns }), [spans, turns])

	const [view, setView] = useState<SessionView>(initialView ?? "overview")
	const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>(undefined)

	return (
		<div className="flex h-screen flex-col bg-background">
			{/* The page's own header, over the fixture — the one place to eyeball it. */}
			<div className="flex shrink-0 items-start gap-4 border-border border-b px-4 py-3">
				<div className="min-w-0 flex-1">
					<SessionHeader sessionId="lab-session-0f3c9a1e2b7d" summary={summary} turns={turns} />
					{selectedSpanId !== undefined && (
						<p className="mt-1 text-muted-foreground text-xs">selected {selectedSpanId}</p>
					)}
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-2">
					<Toggle
						variant="outline"
						size="sm"
						pressed={captureOff}
						onPressedChange={setCaptureOff}
						className="text-xs"
					>
						Capture off
					</Toggle>
					<Toggle
						variant="outline"
						size="sm"
						pressed={truncated}
						onPressedChange={setTruncated}
						className="text-xs"
					>
						Truncated
					</Toggle>
				</div>
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
						truncated={truncated}
						selectedSpanId={selectedSpanId}
						onSelectSpan={setSelectedSpanId}
					/>
				</div>
			</div>
		</div>
	)
}
