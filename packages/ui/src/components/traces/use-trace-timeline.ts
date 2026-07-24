import * as React from "react"
import type { SpanNode } from "../../lib/types"
import type { TimelineBar, ViewportState, TimelineState, TimelineAction } from "./trace-timeline-types"
import {
	ROW_HEIGHT,
	ROW_GAP,
	OVERSCAN,
	MIN_VISIBLE_ABS_MS,
	DEFAULT_MAX_WINDOW_MS,
} from "./trace-timeline-types"
import { getValueHue } from "../../lib/colors"
import { resolveColorValue, isStatusCodePreset, type ColorByField } from "./color-by"
import { computeDefaultExpandedSpanIds, countDescendants } from "./auto-collapse"

// --- Color palette (kept muted to preserve current aesthetic) ---

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

// --- Layout ---

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
): LayoutResult {
	const bars: TimelineBar[] = []
	const barIndexBySpanId = new Map<string, number>()
	let currentRow = 0
	const statusPreset = isStatusCodePreset(colorBy)

	function visit(node: SpanNode) {
		const startMs = new Date(node.startTime).getTime()
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

// --- State reducer ---

export function clampViewport(vp: ViewportState, traceStartMs: number, traceEndMs: number): ViewportState {
	const traceDuration = Math.max(0, traceEndMs - traceStartMs)
	// Trace boundaries with 5% padding each side.
	const padding = traceDuration * 0.05
	const loBound = traceStartMs - padding
	const hiBound = traceEndMs + padding
	const boundWidth = hiBound - loBound

	// Absolute floor only — a proportional floor (traceDuration * k) makes long traces
	// un-zoomable: a 7-min trace would cap the window at tens of ms while the spans you're
	// trying to inspect are µs-scale, so zoom appears not to work. SpanBar clamps its
	// rendered width, so extreme zoom can't emit gigapixel nodes.
	const minDuration = MIN_VISIBLE_ABS_MS
	const maxDuration = Math.max(boundWidth, minDuration)

	const rawDuration = vp.endMs - vp.startMs
	const duration = Number.isFinite(rawDuration)
		? Math.max(minDuration, Math.min(rawDuration, maxDuration))
		: maxDuration

	// Window as wide as (or wider than) the padded trace → center it, so neither edge
	// clamp can push the other back out of bounds (degenerate/near-zero traces included).
	if (duration >= boundWidth) {
		const center = (loBound + hiBound) / 2
		return { startMs: center - duration / 2, endMs: center + duration / 2 }
	}

	// Right-clamp before left-clamp: min() first means the subsequent max() can only pull
	// the window right, never past hiBound (duration < boundWidth guarantees room).
	const startMs = Number.isFinite(vp.startMs)
		? Math.max(loBound, Math.min(vp.startMs, hiBound - duration))
		: loBound
	return { startMs, endMs: startMs + duration }
}

export function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
	switch (action.type) {
		case "RESET":
			return action.state

		case "SET_VIEWPORT":
			// Clamp here (not at dispatch sites) so every path — minimap pan/resize/jump
			// included — is bounded by the same rules as the other gestures.
			return {
				...state,
				viewport: clampViewport(action.viewport, action.traceStartMs, action.traceEndMs),
			}

		case "ZOOM": {
			const { centerMs, factor, traceStartMs, traceEndMs } = action
			const currentDuration = state.viewport.endMs - state.viewport.startMs
			const newDuration = currentDuration / factor
			const ratio = (centerMs - state.viewport.startMs) / currentDuration
			const newStart = centerMs - ratio * newDuration
			return {
				...state,
				viewport: clampViewport(
					{ startMs: newStart, endMs: newStart + newDuration },
					traceStartMs,
					traceEndMs,
				),
			}
		}

		case "PAN": {
			const { deltaMs, traceStartMs, traceEndMs } = action
			return {
				...state,
				viewport: clampViewport(
					{
						startMs: state.viewport.startMs + deltaMs,
						endMs: state.viewport.endMs + deltaMs,
					},
					traceStartMs,
					traceEndMs,
				),
			}
		}

		case "ZOOM_TO_SPAN": {
			const { startMs, endMs, traceStartMs, traceEndMs } = action
			const spanDuration = endMs - startMs
			const padding = Math.max(spanDuration * 0.1, 0.001)
			return {
				...state,
				viewport: clampViewport(
					{ startMs: startMs - padding, endMs: endMs + padding },
					traceStartMs,
					traceEndMs,
				),
			}
		}

		case "ZOOM_TO_RANGE": {
			// Drag-to-select target: zoom to exactly the dragged window (no extra padding),
			// clamped so it stays inside the trace and respects the min-visible floor.
			const { startMs, endMs, traceStartMs, traceEndMs } = action
			const lo = Math.min(startMs, endMs)
			const hi = Math.max(startMs, endMs)
			return {
				...state,
				viewport: clampViewport({ startMs: lo, endMs: hi }, traceStartMs, traceEndMs),
			}
		}

		case "ZOOM_TO_FIT": {
			const { traceStartMs, traceEndMs } = action
			const padding = (traceEndMs - traceStartMs) * 0.02
			return {
				...state,
				viewport: clampViewport(
					{ startMs: traceStartMs - padding, endMs: traceEndMs + padding },
					traceStartMs,
					traceEndMs,
				),
			}
		}

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
			if (next.has(action.spanId)) {
				next.delete(action.spanId)
			} else {
				next.add(action.spanId)
			}
			return { ...state, expandedSpanIds: next }
		}

		case "EXPAND_ALL":
			return { ...state, expandedSpanIds: new Set(action.spanIds) }

		case "COLLAPSE_ALL":
			return { ...state, expandedSpanIds: new Set<string>() }

		default:
			return state
	}
}

// --- Time axis ticks ---

const NICE_INTERVALS = [
	0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000,
	5000, 10000, 20000, 60000,
]

export function computeTimeAxisTicks(
	viewport: ViewportState,
	traceStartMs: number,
	targetTickCount: number = 6,
): number[] {
	const visibleDuration = viewport.endMs - viewport.startMs
	const rawInterval = visibleDuration / targetTickCount

	// Find the nearest "nice" interval
	let interval = NICE_INTERVALS[NICE_INTERVALS.length - 1]
	for (const nice of NICE_INTERVALS) {
		if (nice >= rawInterval) {
			interval = nice
			break
		}
	}

	const ticks: number[] = []
	const offsetFromTraceStart = viewport.startMs - traceStartMs
	const firstTick = Math.ceil(offsetFromTraceStart / interval) * interval
	for (let t = firstTick; t <= viewport.endMs - traceStartMs; t += interval) {
		ticks.push(t)
	}

	return ticks
}

// --- Search ---

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

// --- Main hook ---

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
	state: TimelineState
	dispatch: React.Dispatch<TimelineAction>
	traceStartMs: number
	traceEndMs: number
	visibleDurationMs: number
	timeAxisTicks: number[]
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
			const s = new Date(node.startTime).getTime()
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
	// Traces shorter than the window show in full. Zoom out (Fit / ⌘-scroll) reaches the whole trace.
	const defaultViewport = React.useMemo<ViewportState>(() => {
		const windowMs = Math.min(traceDurationMs, DEFAULT_MAX_WINDOW_MS)
		const pad = windowMs * 0.02
		// Route through clampViewport so the min-width floor holds at first paint too.
		return clampViewport(
			{ startMs: traceStartMs - pad, endMs: traceStartMs + windowMs + pad },
			traceStartMs,
			traceEndMs,
		)
	}, [traceStartMs, traceEndMs, traceDurationMs])

	// Initialize with default expanded spans (auto-collapses big subtrees on long traces).
	const defaultExpanded = React.useMemo(
		() => computeDefaultExpandedSpanIds(rootSpans, { keepVisibleSpanId }),
		[rootSpans, keepVisibleSpanId],
	)

	const [state, dispatch] = React.useReducer(timelineReducer, {
		viewport: defaultViewport,
		focusedIndex: null,
		searchQuery: "",
		expandedSpanIds: defaultExpanded,
	})

	// Reset state when trace data changes
	const rootSpanIdsKey = rootSpans.map((s) => s.spanId).join(",")
	React.useEffect(() => {
		dispatch({
			type: "RESET",
			state: {
				viewport: defaultViewport,
				focusedIndex: null,
				searchQuery: "",
				expandedSpanIds: defaultExpanded,
			},
		})
	}, [rootSpanIdsKey]) // eslint-disable-line react-hooks/exhaustive-deps

	// Layout bars
	const { bars, totalRows, barIndexBySpanId, parentIndexById } = React.useMemo(
		() => layoutSpans(rootSpans, state.expandedSpanIds, colorBy),
		[rootSpans, state.expandedSpanIds, colorBy],
	)

	// Viewport derived values
	const visibleDurationMs = state.viewport.endMs - state.viewport.startMs

	// Time axis ticks
	const timeAxisTicks = React.useMemo(
		() => computeTimeAxisTicks(state.viewport, traceStartMs),
		[state.viewport, traceStartMs],
	)

	// Search
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
		state,
		dispatch,
		traceStartMs,
		traceEndMs,
		visibleDurationMs,
		timeAxisTicks,
		searchMatches,
		isSearchActive,
	}
}

export { ROW_HEIGHT, ROW_GAP, OVERSCAN }
