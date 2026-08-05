import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"

import { cn } from "@maple/ui/lib/utils"
import { Input } from "@maple/ui/components/ui/input"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { MagnifierIcon } from "@/components/icons"
import type { AgentTraceModel, AgentTraceRow, AgentTraceTimelineFilter } from "./agent-trace-model"
import { buildTimelineView } from "./agent-trace-model"
import type { AttachRow } from "./agent-trace-rows"
import { AgentTraceTimelineRow } from "./agent-trace-rows"

// ---------------------------------------------------------------------------
// The timeline, its toolbar, and the navigation affordances a long agent trace
// needs. Short agent traces get two reading toggles; past the condensation
// threshold the toolbar grows filter chips and a search box, because at 142
// turns "scroll until you find it" stops being a strategy.
// ---------------------------------------------------------------------------

const LABEL = "font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"

/** Matches the model's condensation threshold: below it, no navigation chrome is warranted. */
const NAVIGABLE_ROW_THRESHOLD = 48

/**
 * What the agent trace map needs from the timeline. The map's bars cover every row
 * in the model, but a row folded into a collapsed group — or filtered out — has
 * no DOM node to scroll to, so "scroll to this row" has to be able to *reveal*
 * it first. That knowledge (the current filter, query and expanded groups) lives
 * here, so the parent asks through this handle rather than owning the state.
 */
export interface AgentTraceTimelineHandle {
	readonly revealRow: (rowId: string) => void
}

export const AgentTraceTimeline = memo(function AgentTraceTimeline({
	model,
	isLive,
	truncated,
	onVisibleRowsChange,
	ref,
}: {
	model: AgentTraceModel
	isLive: boolean
	truncated: boolean
	onVisibleRowsChange?: (ids: ReadonlySet<string>) => void
	ref?: React.Ref<AgentTraceTimelineHandle>
}) {
	const [filter, setFilter] = useState<AgentTraceTimelineFilter>("all")
	const [query, setQuery] = useState("")
	const [expandedGroupIds, setExpandedGroupIds] = useState<ReadonlySet<string>>(() => new Set())
	const [showToolCalls, setShowToolCalls] = useState(true)
	const [expandBodies, setExpandBodies] = useState(false)

	const navigable = model.rows.length > NAVIGABLE_ROW_THRESHOLD
	const view = useMemo(
		() => buildTimelineView(model, { filter, query, expandedGroupIds, condense: navigable }),
		[model, filter, query, expandedGroupIds, navigable],
	)

	// At most one row is mid-generation: on a live agent trace, the final assistant
	// turn that has not reported a finish reason yet. Selecting it here rather
	// than per row keeps the badge off the user bubbles — which carry no
	// duration and no finish reason of their own, and so all matched a
	// per-row test.
	const streamingRowId = useMemo(() => {
		if (!isLive) return null
		for (let index = view.rows.length - 1; index >= 0; index--) {
			const row = view.rows[index]
			if (row == null || row.type !== "message") continue
			const { event } = row
			if (event.role === "user" || event.role === "tool") return null
			if (event.status === "error" || event.finishReason != null) return null
			return row.id
		}
		return null
	}, [isLive, view.rows])

	// A collapsed group is one DOM node standing in for a run of rows. The map's
	// bars are keyed by the *member* row ids, so reporting only `group-…` would
	// leave the viewport shading with nothing to match while a group is on screen.
	const groupMembers = useMemo(() => {
		const members = new Map<string, ReadonlyArray<string>>()
		for (const row of view.rows) {
			if (row.type === "turnGroup") members.set(row.id, collectRowIds(row.rows))
		}
		return members
	}, [view.rows])

	const groupMembersRef = useRef(groupMembers)
	groupMembersRef.current = groupMembers
	const onVisibleRowsChangeRef = useRef(onVisibleRowsChange)
	onVisibleRowsChangeRef.current = onVisibleRowsChange
	const lastEmittedRef = useRef<ReadonlySet<string>>(new Set())

	// Stable across renders so the observer callback below never has to be rebuilt
	// — an unstable one would re-observe every row on every scroll tick.
	const emitVisibleRows = useCallback((ids: ReadonlySet<string>) => {
		const notify = onVisibleRowsChangeRef.current
		if (notify == null) return
		const expanded = new Set(ids)
		for (const id of ids) {
			for (const member of groupMembersRef.current.get(id) ?? []) expanded.add(member)
		}
		if (sameIds(expanded, lastEmittedRef.current)) return
		lastEmittedRef.current = expanded
		notify(expanded)
	}, [])

	const attachRow = useVisibleRows(emitVisibleRows)

	const toggleGroup = useCallback(
		(id: string) =>
			setExpandedGroupIds((current) => {
				const next = new Set(current)
				if (next.has(id)) next.delete(id)
				else next.add(id)
				return next
			}),
		[],
	)

	// Scrolling to a row that had to be revealed first can only happen after the
	// reveal commits, so the request is parked and drained once the view rebuilds.
	const pendingScrollRef = useRef<string | null>(null)

	// One step per call: reveal what stands between the row and the screen, park
	// the request, and let the redrawn view run the next step. Clearing a filter
	// can put the row back inside a collapsed group, so this is genuinely a loop
	// — but a terminating one, since every step either makes progress or gives up.
	const revealRow = useCallback(
		(rowId: string) => {
			if (scrollToRow(rowId)) {
				pendingScrollRef.current = null
				return
			}

			const group = view.rows.find(
				(row) => row.type === "turnGroup" && row.rows.some((inner) => inner.id === rowId),
			)
			if (group != null) {
				pendingScrollRef.current = rowId
				setExpandedGroupIds((current) => {
					if (current.has(group.id)) return current
					const next = new Set(current)
					next.add(group.id)
					return next
				})
				return
			}

			// Not folded away — filtered away. The map covers the whole agent trace, so
			// asking for a row the filter excludes is a request to leave the filter.
			if (filter !== "all" || query.trim().length > 0) {
				pendingScrollRef.current = rowId
				setFilter("all")
				setQuery("")
				return
			}

			// Nothing left to open: the row isn't in this agent trace's view at all.
			pendingScrollRef.current = null
		},
		[view.rows, filter, query],
	)

	useImperativeHandle(ref, () => ({ revealRow }), [revealRow])

	// Not mount-only and not derivable: the next reveal step can only run once the
	// view it needs has committed, so this drains the parked request per redraw.
	// oxlint-disable-next-line no-restricted-imports
	useEffect(() => {
		if (pendingScrollRef.current != null) revealRow(pendingScrollRef.current)
	}, [revealRow])

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 border-b border-border pb-1.5">
				<span className={LABEL}>Timeline</span>
				<span className="hidden grow sm:block" />

				{navigable && (
					<div className="flex flex-wrap items-center gap-1.5">
						<FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
							All {model.counts.turns}
						</FilterChip>
						{model.counts.errors > 0 && (
							<FilterChip
								active={filter === "errors"}
								onClick={() => setFilter("errors")}
								dot="bg-severity-error"
							>
								Errors {model.counts.errors}
							</FilterChip>
						)}
						{model.counts.handoffs > 0 && (
							<FilterChip active={filter === "handoffs"} onClick={() => setFilter("handoffs")}>
								Handoffs {model.counts.handoffs}
							</FilterChip>
						)}
						{model.counts.toolFailures > 0 && (
							<FilterChip
								active={filter === "toolFailures"}
								onClick={() => setFilter("toolFailures")}
								dot="bg-severity-error"
							>
								Tool failures {model.counts.toolFailures}
							</FilterChip>
						)}
						<span className="relative">
							<MagnifierIcon
								size={11}
								className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
							/>
							<Input
								size="sm"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Filter this agent trace"
								aria-label="Filter this agent trace"
								className="h-[22px] w-48 rounded-sm"
								nativeInput
								style={{ paddingLeft: 22 }}
							/>
						</span>
					</div>
				)}

				<div className="flex items-baseline gap-3">
					<ToolbarLink onClick={() => setShowToolCalls((value) => !value)}>
						{showToolCalls ? "Collapse tool calls" : "Show tool calls"}
					</ToolbarLink>
					<span className="text-border">·</span>
					<ToolbarLink onClick={() => setExpandBodies((value) => !value)}>
						{expandBodies ? "Collapse bodies" : "Expand all bodies"}
					</ToolbarLink>
				</div>
			</div>

			{view.rows.length === 0 ? (
				<p className="rounded-lg border border-dashed border-border px-4 py-8 text-center font-mono text-xs text-muted-foreground">
					No events match this filter.
				</p>
			) : (
				<div className="flex flex-col">
					{view.rows.map((row) => (
						<AgentTraceTimelineRow
							key={row.id}
							row={row}
							showToolCalls={showToolCalls}
							expandBodies={expandBodies}
							streaming={row.id === streamingRowId}
							expandedGroup={expandedGroupIds.has(row.id)}
							onToggleGroup={toggleGroup}
							attachRow={attachRow}
							maxRowDurationMs={model.maxRowDurationMs}
						/>
					))}
				</div>
			)}

			{truncated && (
				<p className="font-mono text-[11px] text-muted-foreground">
					This agent trace exceeded the timeline row cap — earlier turns are not shown.
				</p>
			)}
		</div>
	)
})

/** Every leaf row id under a run, groups included — what the map's bars key on. */
function collectRowIds(rows: ReadonlyArray<AgentTraceRow>): ReadonlyArray<string> {
	const ids: Array<string> = []
	for (const row of rows) {
		ids.push(row.id)
		if (row.type === "turnGroup") ids.push(...collectRowIds(row.rows))
	}
	return ids
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false
	for (const id of a) if (!b.has(id)) return false
	return true
}

/**
 * Returns false when the row has no node on screen — it is folded or filtered
 * away. Matched by scanning `dataset` rather than by an attribute selector: a
 * row id is a span id or a derived `group-…` key, and neither is guaranteed to
 * be a valid CSS identifier once quoted.
 */
function scrollToRow(rowId: string): boolean {
	if (typeof document === "undefined") return false
	for (const node of document.querySelectorAll<HTMLElement>("[data-agent-trace-row]")) {
		if (node.dataset.agentTraceRow !== rowId) continue
		node.scrollIntoView({ block: "center", behavior: "smooth" })
		return true
	}
	return false
}

function FilterChip({
	active,
	onClick,
	dot,
	children,
}: {
	active: boolean
	onClick: () => void
	dot?: string
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={cn(
				"inline-flex h-[22px] items-center gap-1.5 rounded-sm px-2 font-mono text-[11px] leading-none whitespace-nowrap",
				active
					? "bg-muted font-medium text-foreground"
					: "border border-border text-muted-foreground hover:text-foreground",
			)}
		>
			{dot != null && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-[2px]", dot)} />}
			{children}
		</button>
	)
}

function ToolbarLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
		>
			{children}
		</button>
	)
}

/**
 * Reports which rows are on screen so the agent trace map can shade the viewport.
 *
 * Returns a ref callback rather than running an effect: React calls it as each
 * row mounts and unmounts, so the observed set stays correct while rows expand,
 * collapse, condense and get filtered out from under it — an effect would have
 * to re-query the DOM on every one of those.
 */
function useVisibleRows(onChange: ((ids: ReadonlySet<string>) => void) | undefined): AttachRow | undefined {
	const visibleRef = useRef<Set<string>>(new Set())
	const reportedRef = useRef<ReadonlySet<string>>(new Set())
	const observerRef = useRef<IntersectionObserver | null>(null)
	const onChangeRef = useRef(onChange)
	onChangeRef.current = onChange

	// A threshold crossing that doesn't change *which* rows are on screen is not
	// news. Without this every scroll tick handed the page a fresh Set, and an
	// unvirtualised 142-turn timeline re-reconciled the whole way down.
	const report = useCallback(() => {
		if (sameIds(visibleRef.current, reportedRef.current)) return
		const snapshot = new Set(visibleRef.current)
		reportedRef.current = snapshot
		onChangeRef.current?.(snapshot)
	}, [])

	// The observer is shared by every row and outlives any one of them, so nothing
	// in the ref-callback path can be trusted to tear it down.
	useMountEffect(() => () => {
		observerRef.current?.disconnect()
		observerRef.current = null
		visibleRef.current.clear()
	})

	return useCallback(
		(node: HTMLElement | null) => {
			if (node == null || typeof IntersectionObserver === "undefined") return
			if (observerRef.current == null) {
				observerRef.current = new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							const id = (entry.target as HTMLElement).dataset.agentTraceRow
							if (id == null) continue
							if (entry.isIntersecting) visibleRef.current.add(id)
							else visibleRef.current.delete(id)
						}
						report()
					},
					{ threshold: 0 },
				)
			}
			const observer = observerRef.current
			observer.observe(node)
			return () => {
				observer.unobserve(node)
				const id = node.dataset.agentTraceRow
				// A row filtered or condensed away stops being visible the moment it
				// unmounts — reporting that is the whole point of tracking it.
				if (id != null && visibleRef.current.delete(id)) report()
			}
		},
		[report],
	)
}
