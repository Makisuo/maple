import { useLayoutEffect, useMemo, useRef, useState } from "react"

import {
	ChartBarHorizontalIcon,
	GridIcon,
	NetworkNodesIcon,
	SlidersIcon,
	TranscriptIcon,
} from "@/components/icons"
import { Label } from "@maple/ui/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { Switch } from "@maple/ui/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"

import { useAppHotkey } from "@/hooks/use-app-hotkey"
import type { SessionSummary } from "@/lib/agent-sessions/session-summary"
import type { SessionTurn } from "@/lib/agent-sessions/session-turns"
import { SessionFlow } from "./session-flow"
import { SessionOverview } from "./session-overview"
import { sessionToolResults } from "@/lib/agent-sessions/span-detail"
import { SessionTranscript } from "./session-transcript"
import { SessionWaterfall } from "./session-waterfall"
import type { SpanDetailTab } from "./span-expansion"

export const SESSION_VIEWS = ["overview", "trace", "flow", "transcript"] as const
export type SessionView = (typeof SESSION_VIEWS)[number]

export function isSessionView(value: string): value is SessionView {
	return (SESSION_VIEWS as readonly string[]).includes(value)
}

/** Views whose toolbar is the debug pair's: filter, span-kind, and one view-own chip. */
const DEBUG_VIEWS: readonly SessionView[] = ["trace", "flow"]

/**
 * The four readings of one session, behind one switcher.
 *
 * They are siblings rather than sections of a scroll because they answer
 * different questions: Overview is read once and left, while Trace, Flow and
 * Transcript are lived in for minutes. Splitting them is what gives each the
 * whole viewport — and it is why nothing here is shared between Overview and
 * the others but the switcher itself. The debug pair *does* share its toolbar:
 * the filter and the span-kind toggle mean the same thing in both, so a Trace ↔
 * Flow switch keeps them, along with what the reader expanded and where they
 * zoomed. Transcript shares the filter — a query means the same thing there —
 * but not the span-kind toggle, which it has no use for: it never shows the
 * app's own HTTP spans at all.
 */
export function SessionViews({
	view,
	onViewChange,
	turns,
	summary,
	truncated,
	selectedSpanId,
	onSelectSpan,
}: {
	view: SessionView
	onViewChange: (view: SessionView) => void
	turns: readonly SessionTurn[]
	summary: SessionSummary
	/** The response dropped the END of the session — the transcript says so. */
	truncated: boolean
	/** The span expanded inline / open in the flow drawer (`?span=`). */
	selectedSpanId: string | undefined
	/** Raised with a span id to expand it, `undefined` to collapse. */
	onSelectSpan: (spanId: string | undefined) => void
}) {
	const [query, setQuery] = useState("")
	const [agentSpansOnly, setAgentSpansOnly] = useState(true)
	const [collapseIdle, setCollapseIdle] = useState(true)
	const [mergeRepeats, setMergeRepeats] = useState(false)
	const [showThinking, setShowThinking] = useState(true)
	const [showPayloads, setShowPayloads] = useState(false)
	// The views unmount when the view changes, so what the reader opened,
	// collapsed or zoomed lives here — otherwise a look at Flow and back costs
	// them the place they had found in a 600-span session.
	const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(() => new Set())
	// Transcript rows virtualize, so a row scrolled out of view unmounts and its
	// local state would go with it: what the reader opened lives here instead,
	// keyed by row, and holds the rows flipped AWAY from their default.
	const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set())
	const [zoom, setZoom] = useState(1)
	// One tab choice for every span expansion, in both debug views: switching
	// spans — or Trace ↔ Flow — keeps the reader on the tab they chose.
	// `undefined` means no choice yet, and the expansion picks by content.
	const [spanTab, setSpanTab] = useState<SpanDetailTab | undefined>(undefined)

	// 1/2/3/4 switch views from anywhere on the page — the switcher stays
	// reachable without the mouse, which is the point of pinning it up here.
	useAppHotkey("session.viewOverview", () => onViewChange("overview"))
	useAppHotkey("session.viewTrace", () => onViewChange("trace"))
	useAppHotkey("session.viewFlow", () => onViewChange("flow"))
	useAppHotkey("session.viewTranscript", () => onViewChange("transcript"))

	// The sticky control bar wraps at narrow widths, so the views stack under its
	// measured height rather than an assumed one.
	const controlsRef = useRef<HTMLDivElement>(null)
	useLayoutEffect(() => {
		const bar = controlsRef.current
		if (bar === null) return
		const publish = () =>
			bar.parentElement?.style.setProperty("--session-controls-height", `${bar.offsetHeight}px`)
		publish()
		const observer = new ResizeObserver(publish)
		observer.observe(bar)
		return () => observer.disconnect()
	}, [view])

	// Results are reported on other spans than the calls that made them — tool
	// spans, or the next call's input history — so every view resolves them
	// through one session-wide index rather than per expanded span.
	const toolResults = useMemo(() => sessionToolResults(turns.flatMap((turn) => turn.spans)), [turns])

	return (
		<Tabs
			value={view}
			onValueChange={(value) => {
				if (isSessionView(value)) onViewChange(value)
			}}
			// `grow` with its auto basis, never `flex-1`: a zero basis makes every
			// ancestor between here and the page scroller report ~zero intrinsic
			// height, collapsing the views to the floor instead of growing the page.
			className="flex grow flex-col gap-0"
		>
			<div
				ref={controlsRef}
				className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-border border-b bg-background pb-2"
			>
				<TabsList variant="underline" className="shrink-0">
					<TabsTrigger value="overview">
						<GridIcon size={14} />
						Overview
					</TabsTrigger>
					<TabsTrigger value="trace">
						<ChartBarHorizontalIcon size={14} />
						Traces
					</TabsTrigger>
					<TabsTrigger value="flow">
						<NetworkNodesIcon size={14} />
						Flow
					</TabsTrigger>
					<TabsTrigger value="transcript">
						<TranscriptIcon size={14} />
						Transcript
					</TabsTrigger>
				</TabsList>

				{/* Per view: none of these shape the Overview, and a row of controls
				    that do nothing is what made the shared toolbar unreadable. */}
				{view !== "overview" && (
					<div className="ml-auto flex flex-wrap items-center gap-2">
						<SearchInput
							value={query}
							onValueChange={setQuery}
							placeholder={view === "transcript" ? "Filter transcript" : "Filter spans"}
							className="w-56"
						/>
						<ViewOptions
							options={
								DEBUG_VIEWS.includes(view)
									? [
											{
												id: "agent-spans-only",
												label: "Agent spans only",
												hint: "Hides the app's own HTTP and DB spans.",
												enabled: agentSpansOnly,
												onChange: setAgentSpansOnly,
											},
											view === "trace"
												? {
														id: "collapse-idle",
														label: "Collapse idle",
														hint: "Folds the gaps where nothing ran.",
														enabled: collapseIdle,
														onChange: setCollapseIdle,
													}
												: {
														id: "merge-repeats",
														label: "Merge repeat tools",
														hint: "Draws one node for a tool called back to back.",
														enabled: mergeRepeats,
														onChange: setMergeRepeats,
													},
										]
									: [
											{
												id: "show-thinking",
												label: "Show thinking",
												hint: "Keeps the model's reasoning blocks in the transcript.",
												enabled: showThinking,
												onChange: setShowThinking,
											},
											{
												id: "expand-tool-payloads",
												label: "Expand tool payloads",
												hint: "Opens every tool call's arguments and result.",
												enabled: showPayloads,
												onChange: setShowPayloads,
											},
										]
							}
						/>
					</div>
				)}
			</div>

			{/* Overview, Trace and Transcript carry the bottom padding the page
			    scroller gave up (`pb-0`, so the Flow floor can pin flush — see the
			    route); the Flow view stays unpadded for the same reason. */}
			<TabsContent value="overview" className="flex flex-[1_1_auto] flex-col pb-4">
				<SessionOverview
					turns={turns}
					summary={summary}
					// A finding's evidence lives in the Traces view: select the span and
					// go — the waterfall scrolls to and expands the selection on mount.
					onOpenSpan={(spanId) => {
						onSelectSpan(spanId)
						onViewChange("trace")
					}}
				/>
			</TabsContent>
			<TabsContent value="trace" className="flex flex-[1_1_auto] flex-col pb-4">
				<SessionWaterfall
					turns={turns}
					summary={summary}
					query={query}
					agentSpansOnly={agentSpansOnly}
					collapseIdle={collapseIdle}
					collapsedTurns={collapsedTurns}
					onToggleTurn={(turnId) => setCollapsedTurns((previous) => toggled(previous, turnId))}
					selectedSpanId={selectedSpanId}
					onSelectSpan={onSelectSpan}
					spanTab={spanTab}
					onSpanTabChange={setSpanTab}
					toolResults={toolResults}
				/>
			</TabsContent>
			<TabsContent value="flow" className="flex flex-[1_1_auto] flex-col">
				<SessionFlow
					turns={turns}
					mergeRepeats={mergeRepeats}
					query={query}
					agentSpansOnly={agentSpansOnly}
					zoom={zoom}
					onZoomChange={setZoom}
					selectedSpanId={selectedSpanId}
					onSelectSpan={onSelectSpan}
					spanTab={spanTab}
					onSpanTabChange={setSpanTab}
					toolResults={toolResults}
					onOpenTraceView={() => onViewChange("trace")}
				/>
			</TabsContent>
			<TabsContent value="transcript" className="flex flex-[1_1_auto] flex-col pb-4">
				<SessionTranscript
					turns={turns}
					toolResults={toolResults}
					query={query}
					showThinking={showThinking}
					showPayloads={showPayloads}
					truncated={truncated}
					collapsedTurns={collapsedTurns}
					onToggleTurn={(turnId) => setCollapsedTurns((previous) => toggled(previous, turnId))}
					openRows={openRows}
					onToggleRow={(key) => setOpenRows((previous) => toggled(previous, key))}
					selectedSpanId={selectedSpanId}
					onSelectSpan={onSelectSpan}
					onOpenTraceView={() => onViewChange("trace")}
				/>
			</TabsContent>
		</Tabs>
	)
}

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
	const next = new Set(set)
	if (!next.delete(id)) next.add(id)
	return next
}

interface ViewOption {
	readonly id: string
	readonly label: string
	readonly hint: string
	readonly enabled: boolean
	readonly onChange: (enabled: boolean) => void
}

/**
 * What this view shows, behind one trigger.
 *
 * These were a row of pressed-state pills, and a pill reads as a button: it
 * looks like something that DOES a thing, not something that IS on or off — and
 * two of them side by side looked like the same kind of control while one
 * filtered rows out and the other only changed how cards open. Switches say
 * state, the label and its line of prose say what the state does, and the
 * toolbar gets the width back for the filter.
 */
function ViewOptions({ options }: { options: readonly ViewOption[] }) {
	const on = options.filter((option) => option.enabled).length
	return (
		<Popover>
			<PopoverTrigger
				className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-2 text-foreground text-xs transition-colors hover:bg-muted/64 data-[popup-open]:bg-muted/64"
				aria-label="Display options"
			>
				<SlidersIcon size={13} className="text-muted-foreground" />
				Display
				<span className="text-muted-foreground tabular-nums">
					{on}/{options.length}
				</span>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 space-y-3">
				{options.map((option) => (
					<div key={option.id} className="flex items-center justify-between gap-4">
						<div className="space-y-0.5">
							<Label htmlFor={option.id} className="cursor-pointer">
								{option.label}
							</Label>
							<p className="text-muted-foreground text-xs">{option.hint}</p>
						</div>
						<Switch id={option.id} checked={option.enabled} onCheckedChange={option.onChange} />
					</div>
				))}
			</PopoverContent>
		</Popover>
	)
}
