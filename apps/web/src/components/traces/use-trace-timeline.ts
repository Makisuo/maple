import * as React from "react"
import type { SpanNode } from "@/api/tinybird/traces"
import type {
  TimelineBar,
  ViewportState,
  TimelineState,
  TimelineAction,
} from "./trace-timeline-types"
import { ROW_HEIGHT, ROW_GAP, OVERSCAN } from "./trace-timeline-types"

// --- Layout ---

function collectDefaultExpanded(nodes: SpanNode[], depth: number, maxDepth: number): Set<string> {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (node.children.length > 0 && depth < maxDepth) {
      ids.add(node.spanId)
      const childIds = collectDefaultExpanded(node.children, depth + 1, maxDepth)
      childIds.forEach((id) => ids.add(id))
    }
  }
  return ids
}

function countDescendants(node: SpanNode): number {
  let count = 0
  for (const child of node.children) {
    count += 1 + countDescendants(child)
  }
  return count
}

export function layoutSpans(
  rootSpans: SpanNode[],
  expandedSpanIds: Set<string>
): { bars: TimelineBar[]; totalRows: number } {
  const bars: TimelineBar[] = []
  let currentRow = 0

  function visit(node: SpanNode) {
    const startMs = new Date(node.startTime).getTime()
    const endMs = startMs + node.durationMs
    const hasChildren = node.children.length > 0
    const isCollapsed = hasChildren && !expandedSpanIds.has(node.spanId)

    bars.push({
      span: node,
      row: currentRow,
      startMs,
      endMs,
      depth: node.depth,
      parentSpanId: node.parentSpanId,
      isError: node.statusCode === "Error",
      isCollapsed,
      childCount: isCollapsed ? countDescendants(node) : 0,
    })
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

  return { bars, totalRows: currentRow }
}

// --- State reducer ---

export function clampViewport(vp: ViewportState, traceStartMs: number, traceEndMs: number): ViewportState {
  const duration = vp.endMs - vp.startMs
  const traceDuration = traceEndMs - traceStartMs
  const minDuration = traceDuration * 0.001
  const maxDuration = traceDuration * 1.1

  let clampedDuration = Math.max(minDuration, Math.min(duration, maxDuration))
  let startMs = vp.startMs
  let endMs = startMs + clampedDuration

  // Clamp to trace boundaries with 5% padding
  const padding = traceDuration * 0.05
  if (startMs < traceStartMs - padding) {
    startMs = traceStartMs - padding
    endMs = startMs + clampedDuration
  }
  if (endMs > traceEndMs + padding) {
    endMs = traceEndMs + padding
    startMs = endMs - clampedDuration
  }

  return { startMs, endMs }
}

function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
  switch (action.type) {
    case "RESET":
      return action.state

    case "SET_VIEWPORT":
      return { ...state, viewport: action.viewport }

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
          traceEndMs
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
          traceEndMs
        ),
      }
    }

    case "ZOOM_TO_SPAN": {
      const { startMs, endMs, traceStartMs, traceEndMs } = action
      const spanDuration = endMs - startMs
      const padding = spanDuration * 0.1
      return {
        ...state,
        viewport: clampViewport(
          { startMs: startMs - padding, endMs: endMs + padding },
          traceStartMs,
          traceEndMs
        ),
      }
    }

    case "ZOOM_TO_FIT": {
      const { traceStartMs, traceEndMs } = action
      const padding = (traceEndMs - traceStartMs) * 0.02
      return {
        ...state,
        viewport: { startMs: traceStartMs - padding, endMs: traceEndMs + padding },
      }
    }

    case "SET_FOCUSED_INDEX":
      return { ...state, focusedIndex: action.index }

    case "FOCUS_NEXT":
      return {
        ...state,
        focusedIndex: state.focusedIndex === null
          ? 0
          : Math.min(state.focusedIndex + 1, action.maxIndex),
      }

    case "FOCUS_PREV":
      return {
        ...state,
        focusedIndex:
          state.focusedIndex === null ? 0 : Math.max(0, state.focusedIndex - 1),
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
  0.001, 0.002, 0.005,
  0.01, 0.02, 0.05,
  0.1, 0.2, 0.5,
  1, 2, 5,
  10, 20, 50,
  100, 200, 500,
  1000, 2000, 5000,
  10000, 20000, 60000,
]

export function computeTimeAxisTicks(
  viewport: ViewportState,
  traceStartMs: number,
  targetTickCount: number = 6
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

export function computeSearchMatches(
  bars: TimelineBar[],
  query: string
): Set<string> {
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
  defaultExpandDepth?: number
}

export interface UseTraceTimelineResult {
  bars: TimelineBar[]
  totalRows: number
  state: TimelineState
  dispatch: React.Dispatch<TimelineAction>
  traceStartMs: number
  traceEndMs: number
  visibleDurationMs: number
  timeAxisTicks: number[]
  searchMatches: Set<string>
  isSearchActive: boolean
  getBarLeftPercent: (bar: TimelineBar) => number
  getBarWidthPercent: (bar: TimelineBar) => number
  getVisibleBars: (scrollTop: number, containerHeight: number) => TimelineBar[]
}

export function useTraceTimeline({
  rootSpans,
  totalDurationMs,
  traceStartTime,
  defaultExpandDepth = Infinity,
}: UseTraceTimelineOptions): UseTraceTimelineResult {
  const traceStartMs = React.useMemo(
    () => new Date(traceStartTime).getTime(),
    [traceStartTime]
  )
  const traceEndMs = traceStartMs + totalDurationMs

  // Initialize with default expanded spans (those with children, up to depth)
  const defaultExpanded = React.useMemo(
    () => collectDefaultExpanded(rootSpans, 0, defaultExpandDepth),
    [rootSpans, defaultExpandDepth]
  )

  const [state, dispatch] = React.useReducer(timelineReducer, {
    viewport: {
      startMs: traceStartMs - totalDurationMs * 0.02,
      endMs: traceEndMs + totalDurationMs * 0.02,
    },
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
        viewport: {
          startMs: traceStartMs - totalDurationMs * 0.02,
          endMs: traceEndMs + totalDurationMs * 0.02,
        },
        focusedIndex: null,
        searchQuery: "",
        expandedSpanIds: defaultExpanded,
      },
    })
  }, [rootSpanIdsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Layout bars
  const { bars, totalRows } = React.useMemo(
    () => layoutSpans(rootSpans, state.expandedSpanIds),
    [rootSpans, state.expandedSpanIds]
  )

  // Viewport derived values
  const visibleDurationMs = state.viewport.endMs - state.viewport.startMs

  // Time axis ticks
  const timeAxisTicks = React.useMemo(
    () => computeTimeAxisTicks(state.viewport, traceStartMs),
    [state.viewport, traceStartMs]
  )

  // Search
  const searchMatches = React.useMemo(
    () => computeSearchMatches(bars, state.searchQuery),
    [bars, state.searchQuery]
  )

  const isSearchActive = state.searchQuery.trim().length > 0

  // Position helpers
  const getBarLeftPercent = React.useCallback(
    (bar: TimelineBar) => {
      return ((bar.startMs - state.viewport.startMs) / visibleDurationMs) * 100
    },
    [state.viewport.startMs, visibleDurationMs]
  )

  const getBarWidthPercent = React.useCallback(
    (bar: TimelineBar) => {
      return ((bar.endMs - bar.startMs) / visibleDurationMs) * 100
    },
    [visibleDurationMs]
  )

  // Virtualization
  const getVisibleBars = React.useCallback(
    (scrollTop: number, containerHeight: number) => {
      const rowSize = ROW_HEIGHT + ROW_GAP
      const firstVisible = Math.max(0, Math.floor(scrollTop / rowSize) - OVERSCAN)
      const lastVisible = Math.min(
        totalRows - 1,
        Math.ceil((scrollTop + containerHeight) / rowSize) + OVERSCAN
      )
      return bars.filter((bar) => bar.row >= firstVisible && bar.row <= lastVisible)
    },
    [bars, totalRows]
  )

  return {
    bars,
    totalRows,
    state,
    dispatch,
    traceStartMs,
    traceEndMs,
    visibleDurationMs,
    timeAxisTicks,
    searchMatches,
    isSearchActive,
    getBarLeftPercent,
    getBarWidthPercent,
    getVisibleBars,
  }
}
