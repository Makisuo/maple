import type { SpanNode } from "@/api/tinybird/traces"

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
  | { type: "SET_VIEWPORT"; viewport: ViewportState }
  | { type: "ZOOM"; centerMs: number; factor: number; traceStartMs: number; traceEndMs: number }
  | { type: "PAN"; deltaMs: number; traceStartMs: number; traceEndMs: number }
  | { type: "ZOOM_TO_SPAN"; startMs: number; endMs: number; traceStartMs: number; traceEndMs: number }
  | { type: "ZOOM_TO_FIT"; traceStartMs: number; traceEndMs: number }
  | { type: "SET_FOCUSED_INDEX"; index: number | null }
  | { type: "FOCUS_NEXT"; maxIndex: number }
  | { type: "FOCUS_PREV" }
  | { type: "SET_SEARCH"; query: string }
  | { type: "TOGGLE_COLLAPSE"; spanId: string }
  | { type: "EXPAND_ALL"; spanIds: string[] }
  | { type: "COLLAPSE_ALL" }

export const ROW_HEIGHT = 28
export const ROW_GAP = 1
export const MINIMAP_HEIGHT = 36
export const TIME_AXIS_HEIGHT = 28
export const DEPTH_INDENT = 16
export const OVERSCAN = 5
