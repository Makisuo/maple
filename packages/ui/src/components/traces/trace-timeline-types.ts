import type { SpanNode } from "../../lib/types"

export interface TimelineBar {
	span: SpanNode
	row: number
	startMs: number
	endMs: number
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

export interface TimelineState {
	viewport: ViewportState
	focusedIndex: number | null
	searchQuery: string
	expandedSpanIds: Set<string>
}

export type TimelineAction =
	| { type: "RESET"; state: TimelineState }
	| { type: "SET_VIEWPORT"; viewport: ViewportState; traceStartMs: number; traceEndMs: number }
	| { type: "ZOOM"; centerMs: number; factor: number; traceStartMs: number; traceEndMs: number }
	| { type: "PAN"; deltaMs: number; traceStartMs: number; traceEndMs: number }
	| { type: "ZOOM_TO_SPAN"; startMs: number; endMs: number; traceStartMs: number; traceEndMs: number }
	| { type: "ZOOM_TO_RANGE"; startMs: number; endMs: number; traceStartMs: number; traceEndMs: number }
	| { type: "ZOOM_TO_FIT"; traceStartMs: number; traceEndMs: number }
	| { type: "SET_FOCUSED_INDEX"; index: number | null }
	| { type: "FOCUS_NEXT"; maxIndex: number }
	| { type: "FOCUS_PREV" }
	| { type: "SET_SEARCH"; query: string }
	| { type: "TOGGLE_COLLAPSE"; spanId: string }
	| { type: "EXPAND_ALL"; spanIds: string[] }
	| { type: "COLLAPSE_ALL" }

export interface BarRect {
	spanId: string
	row: number
	x: number
	y: number
	w: number
	h: number
}

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
