import { useLayoutEffect, useMemo, useRef, useState } from "react"

import { ClockIcon, NetworkNodesIcon } from "@/components/icons"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { Toggle } from "@maple/ui/components/ui/toggle"
import { cn } from "@maple/ui/lib/utils"

import type { SessionSummary } from "@/lib/agent-sessions/session-summary"
import type { SessionTurn } from "@/lib/agent-sessions/session-turns"
import { SessionFlow } from "./session-flow"
import { filterSpans, type TraceSelection } from "@/lib/agent-sessions/span-filters"
import { SessionWaterfall } from "./session-waterfall"

type SessionView = "timeline" | "flow"

/**
 * The two readings of the same spans, and the controls that shape them.
 *
 * Three things turn a plain waterfall into an agent view — turns, collapsed
 * idle, and hiding the app's own spans — and all three are toggles here rather
 * than assumptions, because each one is occasionally the thing you need to see.
 */
export function SessionViews({
	turns,
	summary,
	selection,
	onOpenTrace,
}: {
	turns: readonly SessionTurn[]
	summary: SessionSummary
	/** The trace/span open in the page's trace pane, for highlighting. */
	selection: TraceSelection | undefined
	onOpenTrace: (target: TraceSelection) => void
}) {
	const [query, setQuery] = useState("")
	const [agentSpansOnly, setAgentSpansOnly] = useState(true)
	const [collapseIdle, setCollapseIdle] = useState(true)
	const [mergeRepeats, setMergeRepeats] = useState(false)
	const [view, setView] = useState<SessionView>("timeline")
	// The views unmount when the tab changes, so what the reader opened, collapsed
	// or zoomed lives here — otherwise a look at Flow and back costs them the
	// place they had found in a 600-span session.
	const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(() => new Set())
	const [zoom, setZoom] = useState(1)

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
	}, [])

	// Counted from what the views actually draw: both of them drop a span the
	// filter hides, and the waterfall drops a turn once every span in it is gone.
	const shown = useMemo(() => {
		let spans = 0
		let turnCount = 0
		const traces = new Set<string>()
		for (const turn of turns) {
			const kept = filterSpans(turn.spans, query, agentSpansOnly)
			if (kept.length === 0) continue
			spans += kept.length
			turnCount += 1
			for (const span of kept) traces.add(span.traceId)
		}
		return { spans, turns: turnCount, traces: traces.size }
	}, [turns, query, agentSpansOnly])

	const counts = [
		countOf(shown.spans, summary.spanCount, "span"),
		countOf(shown.turns, turns.length, "turn"),
		countOf(shown.traces, summary.traceCount, "trace"),
	].join(" · ")

	return (
		<Tabs
			value={view}
			onValueChange={(value) => {
				if (value === "timeline" || value === "flow") setView(value)
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
					<TabsTrigger value="timeline">
						<ClockIcon size={14} />
						Timeline
					</TabsTrigger>
					<TabsTrigger value="flow">
						<NetworkNodesIcon size={14} />
						Flow
					</TabsTrigger>
				</TabsList>

				<div className="ml-auto flex flex-wrap items-center gap-2">
					{/* The filter and the span-kind toggle apply to BOTH views, so both
					    stay mounted in both. Only the view-specific toggles switch. */}
					<SearchInput
						value={query}
						onValueChange={setQuery}
						placeholder="Filter spans"
						className="w-56"
					/>
					<ViewChip
						pressed={agentSpansOnly}
						onPressedChange={setAgentSpansOnly}
						title="Hides the app's own HTTP/DB spans"
					>
						Agent spans only
					</ViewChip>
					{view === "timeline" ? (
						<ViewChip pressed={collapseIdle} onPressedChange={setCollapseIdle}>
							Collapse idle
						</ViewChip>
					) : (
						<ViewChip pressed={mergeRepeats} onPressedChange={setMergeRepeats}>
							Merge repeat tools
						</ViewChip>
					)}
					<span className="whitespace-nowrap text-muted-foreground text-xs tabular-nums">
						{counts}
					</span>
				</div>
			</div>

			<TabsContent value="timeline" className="flex flex-[1_1_auto] flex-col">
				<SessionWaterfall
					turns={turns}
					summary={summary}
					query={query}
					agentSpansOnly={agentSpansOnly}
					collapseIdle={collapseIdle}
					collapsedTurns={collapsedTurns}
					onToggleTurn={(turnId) => setCollapsedTurns((previous) => toggled(previous, turnId))}
					selection={selection}
					onOpenTrace={onOpenTrace}
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
					selection={selection}
					onOpenTrace={onOpenTrace}
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

function countOf(shown: number, total: number, noun: string): string {
	const label = `${noun}${total === 1 ? "" : "s"}`
	return shown === total
		? `${total.toLocaleString()} ${label}`
		: `${shown.toLocaleString()} of ${total.toLocaleString()} ${label}`
}

function ViewChip({
	pressed,
	onPressedChange,
	title,
	children,
}: {
	pressed: boolean
	onPressedChange: (pressed: boolean) => void
	title?: string
	children: string
}) {
	return (
		<Toggle
			variant="outline"
			size="sm"
			pressed={pressed}
			onPressedChange={onPressedChange}
			title={title}
			className="gap-1.5 rounded-full text-xs"
		>
			<span
				aria-hidden
				className={cn("size-1.5 rounded-full", pressed ? "bg-primary" : "bg-muted-foreground/40")}
			/>
			{children}
		</Toggle>
	)
}
