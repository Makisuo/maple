/**
 * One request planner for dashboard widgets — the browser and the share API
 * both go through it.
 *
 * `toWidgetRequest` (`@maple/widgets/dashboard`) lowers a stored data source to
 * `{ endpoint, params }`. What is left before that request can execute — pick
 * the window (a pinned tile beats the board), fill the time macros, substitute
 * dashboard variables, pin the fetch strategy, flag a list scan over the cap —
 * is exactly the part that used to live twice: once inside the signed-in
 * `useWidgetDataSource` hook and once, re-derived, inside the share resolver.
 * The copies disagreed (the share ran query-set and raw-SQL widgets with their
 * `$vars` unsubstituted, and every widget on the batch window even when pinned),
 * so a shared board showed different numbers than the board it shared.
 *
 * Pure and host-free: no React, no Effect, no clock beyond the optional
 * `nowMs`. The input is the *structural* `{ endpoint, params }` rather than a
 * `@maple/widgets` type so this package keeps not importing `@maple/widgets`
 * (see `query-set/dispatch.ts`).
 */
import { interpolateWidgetParams, type VariableValues } from "./dashboard-variables/interpolate"
import { interpolateTimeMacros } from "./dashboard-variables/time-macros"
import { parseWarehouseDateTime, resolveTimeRangeWindow, type TimeRangeInput } from "./datetime"
import { LIST_ENDPOINTS, MAX_LIST_RANGE_SECONDS } from "./limits"

export interface WidgetWindow {
	readonly startTime: string
	readonly endTime: string
}

export interface PlanWidgetRequestInput {
	/** The lowered request — `toWidgetRequest(dataSource)`. */
	readonly request: { readonly endpoint: string; readonly params: Record<string, unknown> }
	/** The board's resolved window; the fallback when the widget pins none. */
	readonly dashboardWindow: WidgetWindow
	/** The widget's own `timeRange`, when the tile is pinned to a window of its own. */
	readonly widgetTimeRange?: TimeRangeInput
	/** Resolved dashboard variable values; `{}` when the board has none. */
	readonly variableValues?: VariableValues
	/**
	 * How many points the tile can display. Attached only to timeseries
	 * requests, where the query-set runner switches its auto bucket to the width
	 * model; other endpoints never see it, so it cannot perturb their cache keys.
	 */
	readonly maxDataPoints?: number
	/** Clock for resolving a relative pinned range; tests inject it. */
	readonly nowMs?: number
	/** Cache-grid snapping of a relative pinned range; default on, as in the browser. */
	readonly snap?: boolean
}

export interface PlannedWidgetRequest {
	readonly kind: "request"
	readonly endpoint: string
	/**
	 * Fully interpolated params — macros then variables, in that order, plus the
	 * window and the pinned strategy. This is the payload the browser sends and
	 * the server executes; both hosts read the window back out of `window`.
	 */
	readonly params: Record<string, unknown>
	readonly window: WidgetWindow
	/**
	 * A list-shaped endpoint over a window wider than `MAX_LIST_RANGE_SECONDS`.
	 * The planner only reports it; the browser refuses and offers to narrow, the
	 * share server narrows and says so. Different UX, one detection.
	 */
	readonly exceedsListCap: boolean
}

export interface DisabledWidgetRequest {
	readonly kind: "disabled"
	readonly reason: "invalid_widget_time_range"
}

export type WidgetRequestPlan = PlannedWidgetRequest | DisabledWidgetRequest

/** The empty-range fallback every dashboard tile pins, on both hosts. */
export const WIDGET_FETCH_STRATEGY = { enableEmptyRangeFallback: false } as const

/** Endpoint whose params carry `maxDataPoints`. Mirrors `QUERY_RESULT_ENDPOINTS.timeseries`. */
const TIMESERIES_ENDPOINT = "custom_query_builder_timeseries"

export const windowSeconds = (window: WidgetWindow): number =>
	Math.max(0, (parseWarehouseDateTime(window.endTime) - parseWarehouseDateTime(window.startTime)) / 1000)

export function planWidgetRequest(input: PlanWidgetRequestInput): WidgetRequestPlan {
	let window: WidgetWindow = input.dashboardWindow
	if (input.widgetTimeRange !== undefined) {
		const resolved = resolveTimeRangeWindow(input.widgetTimeRange, {
			snap: input.snap,
			...(input.nowMs === undefined ? undefined : { nowMs: input.nowMs }),
		})
		if (resolved === null) return { kind: "disabled", reason: "invalid_widget_time_range" }
		window = resolved
	}

	const { endpoint, params } = input.request
	const maxDataPoints = endpoint === TIMESERIES_ENDPOINT ? input.maxDataPoints : undefined

	// Macros first, then variables — the same order the browser has always used,
	// so a `$__startTime` inside a variable's value is never re-expanded.
	const withMacros = interpolateTimeMacros(
		{
			...params,
			strategy: WIDGET_FETCH_STRATEGY,
			...(maxDataPoints === undefined ? undefined : { maxDataPoints }),
			startTime: window.startTime,
			endTime: window.endTime,
		},
		window,
	)
	const interpolated =
		input.variableValues === undefined
			? withMacros
			: interpolateWidgetParams(withMacros, input.variableValues)

	return {
		kind: "request",
		endpoint,
		params: interpolated,
		window,
		exceedsListCap: LIST_ENDPOINTS.has(endpoint) && windowSeconds(window) > MAX_LIST_RANGE_SECONDS,
	}
}
