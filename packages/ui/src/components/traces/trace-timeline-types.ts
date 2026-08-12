import type { SpanNode } from "../../lib/types"

export interface TimelineBar {
	span: SpanNode
	row: number
	startMs: number
	endMs: number
	/** Start offset from the trace start (ms) — the `--b0` custom property on the bar. */
	offsetStartMs: number
	/** End offset from the trace start (ms) — the `--b1` custom property on the bar. */
	offsetEndMs: number
	depth: number
	parentSpanId: string
	isError: boolean
	isCollapsed: boolean
	childCount: number
	fill: string
	borderColor: string
	hasChildren: boolean
}

export interface ViewportState {
	startMs: number
	endMs: number
}

/**
 * React state for the timeline.
 *
 * The viewport is deliberately absent: it lives in `ViewportController`'s ref and reaches the
 * DOM through CSS custom properties, so pan and zoom cost no re-render. Only things that
 * genuinely change what is *rendered* belong here.
 */
export interface TimelineState {
	focusedIndex: number | null
	searchQuery: string
	expandedSpanIds: Set<string>
}

export type TimelineAction =
	| { type: "RESET"; state: TimelineState }
	| { type: "SET_FOCUSED_INDEX"; index: number | null }
	| { type: "FOCUS_NEXT"; maxIndex: number }
	| { type: "FOCUS_PREV" }
	| { type: "SET_SEARCH"; query: string }
	/** Toggle one span; with `descendantIds` the whole subtree follows the node's new state. */
	| { type: "TOGGLE_COLLAPSE"; spanId: string; descendantIds?: readonly string[] }
	| { type: "EXPAND_ALL"; spanIds: string[] }
	| { type: "COLLAPSE_ALL" }
	| { type: "SET_EXPANDED"; spanIds: Set<string> }

export const ROW_HEIGHT = 28
export const ROW_GAP = 1
export const MINIMAP_HEIGHT = 36
export const TIME_AXIS_HEIGHT = 28
export const DEPTH_INDENT = 16
export const OVERSCAN = 20
/** Absolute floor on the visible window so deep zoom can never collapse to zero width. */
export const MIN_VISIBLE_ABS_MS = 0.1
/** Default view shows at most this much time; longer traces open zoomed to the start. */
export const DEFAULT_MAX_WINDOW_MS = 10_000
/** Movement (px) before a pointer-drag on the timeline is treated as a zoom marquee, not a click. */
export const DRAG_ZOOM_THRESHOLD_PX = 4
export const SIDEBAR_WIDTH_DEFAULT = 320
export const SIDEBAR_WIDTH_MIN = 180
export const SIDEBAR_WIDTH_MAX = 640
export const SIDEBAR_WIDTH_STORAGE_KEY = "traceTimelineSidebarWidth"

/**
 * Narrowest label a tick can carry ("1.23 s" plus headroom). The ruler budgets ticks against
 * the measured column width rather than a fixed count, so labels never collide on a narrow
 * panel and never thin out to two on a wide one.
 */
export const MIN_TICK_PX = 56

/** Grab radius (px) on each edge of the minimap's viewport rect. */
export const HANDLE_HIT_AREA = 8
/**
 * Narrowest window the minimap will produce, as a fraction of the trace. Paired with the
 * chart's own `MIN_VISIBLE_ABS_MS` floor: a resize that undershoots this would be silently
 * widened by `clampViewport`, which reads as the handle fighting the cursor.
 */
export const MIN_RANGE_FRAC = 0.002
