import * as React from "react"
import { spanStartMs } from "../../lib/span-tree"
import type { SpanNode } from "../../lib/types"
import type { TimelineBar, ViewportState, TimelineState, TimelineAction } from "./trace-timeline-types"
import { ROW_HEIGHT, ROW_GAP, OVERSCAN, MIN_TICK_PX, DEFAULT_MAX_WINDOW_MS } from "./trace-timeline-types"
import { clampViewport, viewportBounds } from "./clamp-viewport"
import { getValueHue } from "../../lib/colors"
import { resolveColorValue, isStatusCodePreset, type ColorByField } from "./color-by"
import { computeDefaultExpandedSpanIds, countDescendants } from "./auto-collapse"

export { clampViewport }

const ERROR_HUE = 25
const NEUTRAL_FILL = "oklch(0.22 0.005 0)"
const NEUTRAL_BORDER = "oklch(0.45 0.02 0)"

function barFillFromHue(hue: number | null, isError: boolean, statusPreset: boolean): string {
	if (isError && !statusPreset) return `oklch(0.22 0.06 ${ERROR_HUE})`
	if (hue === null) return NEUTRAL_FILL
	return `oklch(0.22 0.015 ${hue})`
}

function barBorderFromHue(hue: number | null, isError: boolean, statusPreset: boolean): string {
	if (isError && !statusPreset) return `oklch(0.62 0.22 ${ERROR_HUE})`
	if (hue === null) return NEUTRAL_BORDER
	return `oklch(0.55 0.18 ${hue})`
}

export interface LayoutResult {
	bars: TimelineBar[]
	totalRows: number
	barIndexBySpanId: Map<string, number>
	parentIndexById: Map<string, number>
}

export function layoutSpans(
	rootSpans: SpanNode[],
	expandedSpanIds: Set<string>,
	colorBy: ColorByField,
	traceStartMs: number,
): LayoutResult {
	const bars: TimelineBar[] = []
	const barIndexBySpanId = new Map<string, number>()
	let currentRow = 0
	const statusPreset = isStatusCodePreset(colorBy)

	function visit(node: SpanNode) {
		const startMs = spanStartMs(node)
		const endMs = startMs + node.durationMs
		const hasChildren = node.children.length > 0
		const isCollapsed = hasChildren && !expandedSpanIds.has(node.spanId)
		const isError = node.statusCode === "Error"

		const value = resolveColorValue(node, colorBy)
		const hue = getValueHue(value)

		const bar: TimelineBar = {
			span: node,
			row: currentRow,
			startMs,
			endMs,
			// Trace-relative, because these become the `--b0`/`--b1` custom properties and the
			// viewport's `--vp0` is trace-relative too. See `writeTimeSurface`.
			offsetStartMs: startMs - traceStartMs,
			offsetEndMs: endMs - traceStartMs,
			depth: node.depth,
			parentSpanId: node.parentSpanId,
			isError,
			isCollapsed,
			childCount: isCollapsed ? countDescendants(node) : 0,
			fill: barFillFromHue(hue, isError, statusPreset),
			borderColor: barBorderFromHue(hue, isError, statusPreset),
			hasChildren,
		}
		bars.push(bar)
		barIndexBySpanId.set(node.spanId, currentRow)
		currentRow++

		if (!isCollapsed) {
			for (const child of node.children) {
				visit(child)
			}
		}
	}

	for (const root of rootSpans) {
		visit(root)
	}

	const parentIndexById = new Map<string, number>()
	for (const bar of bars) {
		if (bar.parentSpanId) {
			const parentIdx = barIndexBySpanId.get(bar.parentSpanId)
			if (parentIdx !== undefined) parentIndexById.set(bar.span.spanId, parentIdx)
		}
	}

	return { bars, totalRows: currentRow, barIndexBySpanId, parentIndexById }
}

/**
 * Every span id that has children, bucketed by depth.
 *
 * Walks the whole tree (not just the expanded rows), because "expand one level" has to know
 * about parents that are currently hidden inside a collapsed ancestor. Built once per tree so
 * the level-at-a-time buttons are O(level) rather than O(tree) per click.
 */
export function collectParentIdsByLevel(rootSpans: SpanNode[]): Map<number, Set<string>> {
	const byLevel = new Map<number, Set<string>>()
	const visit = (node: SpanNode) => {
		if (node.children.length > 0) {
			let level = byLevel.get(node.depth)
			if (!level) {
				level = new Set()
				byLevel.set(node.depth, level)
			}
			level.add(node.spanId)
			node.children.forEach(visit)
		}
	}
	rootSpans.forEach(visit)
	return byLevel
}

export function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
	switch (action.type) {
		case "RESET":
			return action.state

		case "SET_FOCUSED_INDEX":
			return { ...state, focusedIndex: action.index }

		case "FOCUS_NEXT":
			return {
				...state,
				focusedIndex:
					state.focusedIndex === null ? 0 : Math.min(state.focusedIndex + 1, action.maxIndex),
			}

		case "FOCUS_PREV":
			return {
				...state,
				focusedIndex: state.focusedIndex === null ? 0 : Math.max(0, state.focusedIndex - 1),
			}

		case "SET_SEARCH":
			return { ...state, searchQuery: action.query }

		case "TOGGLE_COLLAPSE": {
			const next = new Set(state.expandedSpanIds)
			const expanding = !next.has(action.spanId)
			if (expanding) next.add(action.spanId)
			else next.delete(action.spanId)
			// Alt-click: drag the whole subtree to the state the clicked node just took, so one
			// gesture opens or folds a branch entirely instead of one level at a time.
			for (const id of action.descendantIds ?? []) {
				if (expanding) next.add(id)
				else next.delete(id)
			}
			return { ...state, expandedSpanIds: next }
		}

		case "EXPAND_ALL":
			return { ...state, expandedSpanIds: new Set(action.spanIds) }

		case "COLLAPSE_ALL":
			return { ...state, expandedSpanIds: new Set<string>() }

		case "SET_EXPANDED":
			return { ...state, expandedSpanIds: action.spanIds }

		default:
			return state
	}
}

// Sub-millisecond up to an hour: the 1/2/5 x 10^n ladder plus the clock values a
// duration ruler wants (15s, 30s, and the quarter-hour rungs a session axis
// spends most of its time on).
const NICE_INTERVALS = [
	0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000,
	5_000, 10_000, 15_000, 20_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
]

/** Snap up to the nearest nice interval — never down, or the tick count overshoots the budget. */
export function niceIntervalAtLeast(rawInterval: number): number {
	for (const nice of NICE_INTERVALS) {
		if (nice >= rawInterval) return nice
	}
	// Past the ladder (sessions that wait on a human): keep stepping by whole hours.
	const hour = 3_600_000
	return Math.max(hour, Math.ceil(rawInterval / hour) * hour)
}

/**
 * Tick spacing budgeted against the measured column, not a fixed tick count.
 *
 * A fixed count (the old `targetTickCount = 6`) collides labels on a narrow panel and leaves a
 * wide one nearly empty. Dividing by `MIN_TICK_PX` gives whatever count actually fits.
 */
export function tickIntervalForWidth(visibleDurationMs: number, columnWidthPx: number): number {
	const maxTicks = Math.max(1, Math.floor(columnWidthPx / MIN_TICK_PX))
	return niceIntervalAtLeast(visibleDurationMs / maxTicks)
}

/**
 * Tick offsets from the trace start covering the window, plus the interval they were spaced at
 * (the label formatter needs it to pick a precision that keeps adjacent labels distinct).
 */
export function computeTimeAxisTicks(
	viewport: ViewportState,
	traceStartMs: number,
	columnWidthPx: number,
): { ticks: number[]; intervalMs: number } {
	const visibleDuration = viewport.endMs - viewport.startMs
	if (!(visibleDuration > 0) || !(columnWidthPx > 0)) return { ticks: [], intervalMs: 1 }

	const intervalMs = tickIntervalForWidth(visibleDuration, columnWidthPx)
	const ticks: number[] = []
	const from = viewport.startMs - traceStartMs
	const to = viewport.endMs - traceStartMs
	const firstTick = Math.ceil(from / intervalMs) * intervalMs
	// Bounded independently of the arithmetic: a pathological interval must not spin here.
	for (let t = firstTick, i = 0; t <= to && i < 512; t += intervalMs, i++) {
		ticks.push(t)
	}
	return { ticks, intervalMs }
}

export function computeSearchMatches(bars: TimelineBar[], query: string): Set<string> {
	if (!query.trim()) return new Set()
	const q = query.toLowerCase()
	const matches = new Set<string>()
	for (const bar of bars) {
		if (
			bar.span.spanName.toLowerCase().includes(q) ||
			bar.span.serviceName.toLowerCase().includes(q) ||
			bar.span.spanId.toLowerCase().includes(q)
		) {
			matches.add(bar.span.spanId)
		}
	}
	return matches
}

export interface UseTraceTimelineOptions {
	rootSpans: SpanNode[]
	totalDurationMs: number
	traceStartTime: string
	colorBy: ColorByField
	/** Keep this span's ancestor chain expanded so auto-collapse never hides it. */
	keepVisibleSpanId?: string
}

export interface UseTraceTimelineResult {
	bars: TimelineBar[]
	totalRows: number
	barIndexBySpanId: Map<string, number>
	parentIndexById: Map<string, number>
	parentIdsByLevel: Map<number, Set<string>>
	state: TimelineState
	dispatch: React.Dispatch<TimelineAction>
	traceStartMs: number
	traceEndMs: number
	/** Window to open (and re-open) the trace at — feeds the viewport controller. */
	defaultViewport: ViewportState
	searchMatches: Set<string>
	isSearchActive: boolean
}

export function useTraceTimeline({
	rootSpans,
	totalDurationMs,
	traceStartTime,
	colorBy,
	keepVisibleSpanId,
}: UseTraceTimelineOptions): UseTraceTimelineResult {
	// Trace bounds must span EVERY span, not just `traceStartTime + totalDurationMs`.
	// On synthetic-root ("Missing Span") or clock-skewed traces, totalDurationMs (the
	// reported root duration) can be far smaller than the real extent of the children,
	// which would clamp the viewport to a tiny window and make the rest of the timeline
	// unreachable by pan/zoom. Derive the actual [min start, max end] from the spans and
	// only fall back to the reported window when there are no spans.
	const { traceStartMs, traceEndMs } = React.useMemo(() => {
		const reportedStart = new Date(traceStartTime).getTime()
		let minStart = Number.POSITIVE_INFINITY
		let maxEnd = Number.NEGATIVE_INFINITY
		const visit = (node: SpanNode) => {
			const s = spanStartMs(node)
			if (Number.isFinite(s)) {
				if (s < minStart) minStart = s
				const e = s + node.durationMs
				if (e > maxEnd) maxEnd = e
			}
			node.children.forEach(visit)
		}
		rootSpans.forEach(visit)
		let start: number
		let end: number
		if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) {
			start = reportedStart
			end = reportedStart + totalDurationMs
		} else {
			start = Math.min(reportedStart, minStart)
			end = Math.max(reportedStart + totalDurationMs, maxEnd)
		}
		// Zero-duration traces (single instantaneous span) get a 1ms synthetic window so every
		// downstream `x / traceDuration` (minimap %, axis %, ticks, fit padding) stays finite.
		if (end <= start) end = start + 1
		return { traceStartMs: start, traceEndMs: end }
	}, [rootSpans, traceStartTime, totalDurationMs])

	const traceDurationMs = traceEndMs - traceStartMs

	// Default view shows at most DEFAULT_MAX_WINDOW_MS (10s) starting at the trace start, so long
	// traces open zoomed-in and readable instead of squeezing minutes of spans into the panel.
	//
	// A trace that fits opens at exactly the padded bounds — the same span the minimap strip
	// covers — so at rest the strip and the timeline column are the same coordinate space and a
	// given instant sits at the same x in both. Opening at some *other* "whole trace" window
	// (this used to apply its own 2% pad) left the two a couple of percent out of step, which
	// reads as the minimap being subtly misaligned with the ruler.
	const defaultViewport = React.useMemo<ViewportState>(() => {
		const bounds = viewportBounds(traceStartMs, traceEndMs)
		if (traceDurationMs <= DEFAULT_MAX_WINDOW_MS) {
			return clampViewport({ startMs: bounds.loMs, endMs: bounds.hiMs }, traceStartMs, traceEndMs)
		}
		// Long trace: open on the first window. Route through clampViewport so the min-width
		// floor holds at first paint too.
		const pad = DEFAULT_MAX_WINDOW_MS * 0.02
		return clampViewport(
			{ startMs: traceStartMs - pad, endMs: traceStartMs + DEFAULT_MAX_WINDOW_MS + pad },
			traceStartMs,
			traceEndMs,
		)
	}, [traceStartMs, traceEndMs, traceDurationMs])

	const defaultExpanded = React.useMemo(
		() => computeDefaultExpandedSpanIds(rootSpans, { keepVisibleSpanId }),
		[rootSpans, keepVisibleSpanId],
	)

	const [state, dispatch] = React.useReducer(timelineReducer, {
		focusedIndex: null,
		searchQuery: "",
		expandedSpanIds: defaultExpanded,
	})

	const rootSpanIdsKey = rootSpans.map((s) => s.spanId).join(",")
	React.useEffect(() => {
		dispatch({
			type: "RESET",
			state: { focusedIndex: null, searchQuery: "", expandedSpanIds: defaultExpanded },
		})
	}, [rootSpanIdsKey]) // eslint-disable-line react-hooks/exhaustive-deps

	const { bars, totalRows, barIndexBySpanId, parentIndexById } = React.useMemo(
		() => layoutSpans(rootSpans, state.expandedSpanIds, colorBy, traceStartMs),
		[rootSpans, state.expandedSpanIds, colorBy, traceStartMs],
	)

	const parentIdsByLevel = React.useMemo(() => collectParentIdsByLevel(rootSpans), [rootSpans])

	const searchMatches = React.useMemo(
		() => computeSearchMatches(bars, state.searchQuery),
		[bars, state.searchQuery],
	)

	const isSearchActive = state.searchQuery.trim().length > 0

	return {
		bars,
		totalRows,
		barIndexBySpanId,
		parentIndexById,
		parentIdsByLevel,
		state,
		dispatch,
		traceStartMs,
		traceEndMs,
		defaultViewport,
		searchMatches,
		isSearchActive,
	}
}

export { ROW_HEIGHT, ROW_GAP, OVERSCAN }
