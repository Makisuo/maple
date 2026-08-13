import { useMemo, useState } from "react"
import { Atom, Result } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Effect, Schedule, Schema } from "effect"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { useDashboardVariablesOptional } from "@/components/dashboard-builder/dashboard-variables-context"
import { useWidgetTimeRangeOverride } from "@/components/dashboard-builder/widgets/widget-time-range-context"
import { resolveTimeRange } from "@/atoms/dashboard-time-range-atoms"
import { getServerFunction, toWidgetRequest } from "@/components/dashboard-builder/data-source-registry"
import { hasUnresolvedVariableRefs, interpolateWidgetParams } from "@maple/query-engine"
import type { DashboardWidget, TimeRange, WidgetDataSource } from "@/components/dashboard-builder/types"

/**
 * The structural shape a data source must satisfy to be fetched. Both the
 * web `WidgetDataSource` and the JSON-decoded `display.sparkline.dataSource`
 * (whose `endpoint` is only typed as `string`) are assignable to this.
 */
export type WidgetDataSourceLike = {
	endpoint: string
	params?: Record<string, unknown>
	transform?: WidgetDataSource["transform"]
}
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import type { WidgetDataState } from "@/components/dashboard-builder/types"
import { encodeKey, encodeOrgScopedKey, identityFromKey, orgScopedKeyPayload } from "@/lib/cache-key"
import { nextRetentionNamespace, withRetention } from "@/lib/services/atoms/retained-atom"
import { getActiveOrgId } from "@/lib/services/common/auth-headers"
import { displayError } from "@/lib/error-messages"
import { Cause, Option } from "effect"
import { WarehouseDecodeError, type BackendError, type WarehouseApiError } from "@/api/warehouse/effect-utils"
import { QueryEngineValidationError } from "@maple/domain/http"
import { MAX_LIST_RANGE_SECONDS, formatRangeSeconds } from "@maple/query-engine"
import { formatForTinybird } from "@/lib/time-utils"
import { normalizeTimestampInput } from "@/lib/timezone-format"

// An error means "the query input/response failed validation" (rather than a
// transient runtime failure) when it is one of these tagged validation errors,
// either directly or as the `cause` wrapped inside a `WidgetDataAtomError`.
const isDecodeError = (value: unknown): boolean =>
	value instanceof WarehouseDecodeError || value instanceof QueryEngineValidationError

// Pull the most meaningful error out of whatever `onError` / a Cause hands us:
// a flattened `Cause` yields its first failure; a bare error is returned as-is.
const extractError = (input: unknown): unknown =>
	Cause.isCause(input) ? Option.getOrElse(Cause.findErrorOption(input), () => input) : input

// A validation error the engine raised because the window is wider than the
// query kind supports. Classified apart from other decode errors so the tile
// renders the muted "narrow your range" state instead of a red block with a
// "Fix with AI" button — there is nothing about the widget to fix.
const isRangeError = (value: unknown): boolean =>
	value instanceof QueryEngineValidationError && /time range too large/i.test(value.message)

const classifyWidgetErrorKind = (input: unknown): "decode" | "runtime" | "range" => {
	const error = extractError(input)
	if (isRangeError(error)) return "range"
	if (error instanceof WidgetDataAtomError && isRangeError(error.cause)) return "range"
	if (isDecodeError(error)) return "decode"
	if (error instanceof WidgetDataAtomError && isDecodeError(error.cause)) return "decode"
	return "runtime"
}

// Endpoints whose queries are `kind: "list"` — they scan raw rows and so carry
// the engine's much tighter list ceiling.
const LIST_ENDPOINTS: ReadonlySet<string> = new Set(["custom_query_builder_list", "list_traces", "list_logs"])

const rangeSecondsOf = (range: { startTime: string; endTime: string }): number =>
	(Date.parse(normalizeTimestampInput(range.endTime)) -
		Date.parse(normalizeTimestampInput(range.startTime))) /
	1000

function isSeriesNameHidden(seriesName: string, hiddenBaseNames: Set<string>): boolean {
	for (const base of hiddenBaseNames) {
		if (seriesName === base) return true
		if (seriesName.startsWith(`${base}: `)) return true
		if (seriesName === `${base} (prev)`) return true
		if (seriesName.startsWith(`${base}: `) && seriesName.endsWith(" (prev)")) return true
	}
	return false
}

function filterHiddenSeriesRows(
	rows: Array<Record<string, unknown>>,
	baseNames: string[],
): Array<Record<string, unknown>> {
	if (baseNames.length === 0) return rows

	const hiddenBaseNames = new Set(baseNames)

	return rows.map((row) => {
		const filtered: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(row)) {
			if (key === "bucket" || !isSeriesNameHidden(key, hiddenBaseNames)) {
				filtered[key] = value
			}
		}
		return filtered
	})
}

function interpolateParams(
	params: Record<string, unknown>,
	resolvedTime: { startTime: string; endTime: string },
): Record<string, unknown> {
	const result: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(params)) {
		if (typeof value === "string") {
			if (value === "$__startTime") {
				result[key] = resolvedTime.startTime
			} else if (value === "$__endTime") {
				result[key] = resolvedTime.endTime
			} else {
				result[key] = value
			}
		} else {
			result[key] = value
		}
	}

	return result
}

function applyTransform(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	data: any,
	transform: WidgetDataSource["transform"],
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
	if (!transform || !data) return data

	// Handle both { data: [...] } and raw array responses
	let rows = Array.isArray(data) ? data : data.data
	if (!Array.isArray(rows)) {
		// If data is a plain object (e.g. errors_summary returns a scalar object),
		// wrap it in an array so reduceToValue and other transforms can process it
		if (typeof data === "object" && data !== null && transform.reduceToValue) {
			rows = [data]
		} else {
			return data
		}
	}

	if (transform.hideSeries?.baseNames.length) {
		rows = filterHiddenSeriesRows(rows as Array<Record<string, unknown>>, transform.hideSeries.baseNames)
	}

	// fieldMap: remap response fields
	if (transform.fieldMap) {
		const map = transform.fieldMap
		rows = rows.map((row: Record<string, unknown>) => {
			const mapped: Record<string, unknown> = { ...row }
			for (const [targetKey, sourceKey] of Object.entries(map)) {
				mapped[targetKey] = row[sourceKey]
			}
			return mapped
		})
	}

	// sortBy
	if (transform.sortBy) {
		const { field, direction } = transform.sortBy
		rows = rows.toSorted((a: Record<string, unknown>, b: Record<string, unknown>) => {
			const aVal = a[field] ?? 0
			const bVal = b[field] ?? 0
			const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0
			return direction === "desc" ? -cmp : cmp
		})
	}

	// limit
	if (transform.limit) {
		rows = rows.slice(0, transform.limit)
	}

	// flattenSeries: extract values from timeseries {bucket, series: {key: val}} into flat rows
	if (transform.flattenSeries) {
		const { valueField } = transform.flattenSeries
		const flatRows: Array<Record<string, unknown>> = []
		for (const row of rows as Array<Record<string, unknown>>) {
			const series = row.series as Record<string, number> | undefined
			if (series) {
				for (const [key, val] of Object.entries(series)) {
					const { series: _discardSeries, ...rest } = row
					flatRows.push({ ...rest, name: key, [valueField]: val })
				}
			}
		}
		rows = flatRows
	}

	// computeRatio: derive a ratio from named breakdown rows (returns a single number)
	if (transform.computeRatio) {
		const { numeratorName, denominatorNames } = transform.computeRatio
		const rowMap = new Map<string, number>()
		for (const row of rows as Array<Record<string, unknown>>) {
			const name = String(row.name ?? "")
			rowMap.set(name, Number(row.value ?? 0))
		}
		const numerator = rowMap.get(numeratorName) ?? 0
		const denominator = denominatorNames.reduce((sum, n) => sum + (rowMap.get(n) ?? 0), 0)
		return denominator > 0 ? numerator / denominator : 0
	}

	// reduceToValue: collapse rows to a single value
	if (transform.reduceToValue) {
		const { field, aggregate = "first" } = transform.reduceToValue
		if (rows.length === 0) return 0

		const resolveField = (): string | null => {
			if (
				rows.some(
					(row: Record<string, unknown>) =>
						typeof row[field] === "number" || typeof row[field] === "string",
				)
			) {
				return field
			}

			const firstNumericField = Object.entries(rows[0] as Record<string, unknown>).find(
				([key, value]) => key !== "bucket" && typeof value === "number",
			)?.[0]

			return firstNumericField ?? null
		}

		const resolvedField = resolveField()
		if (!resolvedField && aggregate !== "count") {
			return 0
		}

		switch (aggregate) {
			case "first":
				return Number(rows[0]?.[resolvedField ?? ""] ?? 0)
			case "sum":
				return rows.reduce(
					(acc: number, row: Record<string, unknown>) =>
						acc + Number(row[resolvedField ?? ""] ?? 0),
					0,
				)
			case "count":
				return rows.length
			case "avg": {
				const sum = rows.reduce(
					(acc: number, row: Record<string, unknown>) =>
						acc + Number(row[resolvedField ?? ""] ?? 0),
					0,
				)
				return sum / rows.length
			}
			case "max":
				return Math.max(
					...rows.map((r: Record<string, unknown>) => Number(r[resolvedField ?? ""] ?? 0)),
				)
			case "min":
				return Math.min(
					...rows.map((r: Record<string, unknown>) => Number(r[resolvedField ?? ""] ?? 0)),
				)
		}
	}

	return rows
}

class WidgetDataAtomError extends Schema.TaggedError<WidgetDataAtomError>()(
	"@maple/web/hooks/WidgetDataAtomError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Unknown),
	},
) {}

// Errors that mean "the query ran fine, the time range just had no rows."
// These should surface immediately as the "No data" UI in WidgetFrame —
// retrying does not help and creates a runaway request loop.
const EXPECTED_EMPTY_MESSAGES = new Set([
	"No query data found in selected time range",
	"No breakdown data found in selected time range",
	"No list data found in selected time range",
	"No successful query results",
	"No enabled queries to run",
])

const isExpectedEmptyDataError = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null) return false
	const message = (error as { message?: unknown }).message
	return typeof message === "string" && EXPECTED_EMPTY_MESSAGES.has(message)
}

// The error channel the widget-fetch atom exposes: every failure is either a
// `WidgetDataAtomError` (parse / unknown endpoint) or the server function's
// existing local/v1/v2 error. Preserve those states for `displayError`.
type WidgetFetchError = WidgetDataAtomError | WarehouseApiError | BackendError

const toWidgetDataAtomError = (error: unknown): WidgetDataAtomError => {
	if (error instanceof Error) {
		return new WidgetDataAtomError({
			message: error.message,
			cause: error,
		})
	}

	return new WidgetDataAtomError({
		message: "Widget data query failed",
		cause: error,
	})
}

const fetchWidgetData = Effect.fnUntraced(
	function* (key: string) {
		const parsed = yield* Effect.try({
			// The key is org-scoped; only the payload after the separator is JSON.
			try: () =>
				JSON.parse(orgScopedKeyPayload(key)) as {
					endpoint: string
					params: Record<string, unknown>
				},
			catch: toWidgetDataAtomError,
		})

		const serverFn = getServerFunction(parsed.endpoint)
		if (!serverFn) {
			return yield* new WidgetDataAtomError({
				message: `Unknown endpoint: ${parsed.endpoint}`,
			})
		}

		const response = yield* serverFn({ data: parsed.params })
		return (response as { data?: unknown })?.data ?? response
	},
	Effect.retry({
		times: 2,
		schedule: Schedule.exponential("500 millis"),
		while: (error) => !isExpectedEmptyDataError(error),
	}),
)

// Built on the mounted `MapleApiAtomClient.runtime`, not bare `Atom.make`. A bare atom
// runs with an empty context, so `CurrentMemoMap` is absent and the `Effect.provide` inside
// each server function rebuilds the whole `mapleApiClientLayer` graph — client, HttpClient
// with its retry/`peer.service` transforms, tracer, logger — on every fetch *and* every
// retry. On an N-tile dashboard that was N+ full layer builds per load. The runtime also
// puts the real tracer in scope, so logs and span annotations here no longer no-op.
//
// Namespaced like the warehouse query families. This one family serves every
// endpoint, but the endpoint is part of the payload and so already part of the
// identity; the namespace only has to keep it clear of the query atoms.
const WIDGET_RETENTION_NAMESPACE = nextRetentionNamespace()

const widgetFetchFamily = Atom.family((key: string) =>
	// Retained so a tile whose dashboard range has rolled onto a new grid cell
	// re-renders its previous values while the new window loads.
	withRetention(
		MapleApiAtomClient.runtime.atom(fetchWidgetData(key)).pipe(Atom.setIdleTTL(120_000)),
		`${WIDGET_RETENTION_NAMESPACE}:${identityFromKey(key)}`,
	),
)

const widgetFetchAtom = (input: { endpoint: string; params: Record<string, unknown> }) =>
	widgetFetchFamily(encodeOrgScopedKey(getActiveOrgId(), input))

/**
 * Fetches and transforms data for a single data source. Powers both whole
 * widgets (via `useWidgetData`) and secondary fetches such as a stat widget's
 * sparkline. Pass `undefined` to render a disabled state without a fetch.
 */
export function useWidgetDataSource(
	dataSource: WidgetDataSourceLike | undefined,
	/**
	 * When false, the data source is "paused": no query is issued and the widget
	 * renders a loading state. Used to gate dashboard tiles on viewport
	 * visibility (lazy-load) so off-screen tiles don't fire queries on mount.
	 */
	enabled = true,
	/**
	 * Pins this fetch to a window of its own instead of the dashboard's. Callers
	 * that already hold the widget pass `widget.timeRange`; nested fetches inside
	 * a widget (a stat's sparkline) inherit it from context instead.
	 */
	timeRangeOverride?: TimeRange,
) {
	const {
		state: { resolvedTimeRange: dashboardTimeRange },
	} = useDashboardTimeRange()
	const contextOverride = useWidgetTimeRangeOverride()
	const override = timeRangeOverride ?? contextOverride ?? undefined
	const overrideKey = override ? encodeKey(override) : null

	// The stored data source resolved to an endpoint + params, once. Everything
	// below reads `request` rather than `dataSource` so the fetch path never
	// touches the stored shape — the v2 → v3 flip lands entirely inside
	// `toWidgetRequest`. Null means no server function can serve it.
	const request = useMemo(() => toWidgetRequest(dataSource), [dataSource])

	const effectiveTimeRange = useMemo(
		() => (override ? resolveTimeRange(override) : dashboardTimeRange),
		// Keyed on the serialized override, not its identity: the dashboard object
		// is rebuilt on every optimistic write, and re-resolving an unchanged
		// override would hand every pinned tile fresh params and refetch it.
		// `dashboardTimeRange` stays in the deps so a manual reload or auto-refresh
		// (which gives it a new identity) rebases a relative override against "now"
		// as well.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[overrideKey, dashboardTimeRange],
	)

	// A list-kind tile on a window wider than the engine's list cap. Detected
	// here rather than left to the API so the tile never fires a request that is
	// certain to 400 (and never burns the fetch's two retries on it).
	const exceedsListCap =
		request !== null &&
		LIST_ENDPOINTS.has(request.endpoint) &&
		effectiveTimeRange !== null &&
		rangeSecondsOf(effectiveTimeRange) > MAX_LIST_RANGE_SECONDS

	// Opt-in, per-tile, not persisted: the viewer can pull just this tile back to
	// the cap without touching the dashboard's range or needing write access.
	const [narrowedToCap, setNarrowedToCap] = useState(false)
	const narrowed = narrowedToCap && exceedsListCap

	const resolvedTimeRange = useMemo(() => {
		if (!narrowed || !effectiveTimeRange) return effectiveTimeRange
		const endMs = Date.parse(normalizeTimestampInput(effectiveTimeRange.endTime))
		return {
			startTime: formatForTinybird(new Date(endMs - MAX_LIST_RANGE_SECONDS * 1000)),
			endTime: effectiveTimeRange.endTime,
		}
	}, [narrowed, effectiveTimeRange])
	const variablesContext = useDashboardVariablesOptional()

	const isStatic = request?.endpoint === "markdown_static"
	const hasServerFn = request !== null && !!getServerFunction(request.endpoint)

	const disableReason = !dataSource
		? "No data source configured"
		: request === null
			? "Unsupported data source"
			: isStatic
				? null
				: !resolvedTimeRange
					? override
						? "Unable to resolve this widget's time range"
						: "Unable to resolve dashboard time range"
					: !hasServerFn
						? `Unknown data source endpoint: ${request.endpoint}`
						: null

	// A params blob referencing a defined dashboard variable whose value hasn't
	// resolved yet (query-variable options still loading, no default) must not
	// fire — a literal `$service` would reach the API. Mirrors the
	// `resolvedTimeRange` gate: the widget reads as "loading" until it settles.
	const waitingOnVariables = useMemo(
		() =>
			variablesContext !== null &&
			hasUnresolvedVariableRefs(
				request?.params,
				variablesContext.variables.map((variable) => variable.name),
				variablesContext.values,
			),
		[request?.params, variablesContext],
	)

	const variableValues = variablesContext?.values

	const resolvedParams = useMemo(() => {
		if (!resolvedTimeRange) return {}
		const base = interpolateParams(
			{
				...request?.params,
				strategy: { enableEmptyRangeFallback: false },
				startTime: resolvedTimeRange.startTime,
				endTime: resolvedTimeRange.endTime,
			},
			resolvedTimeRange,
		)
		return variableValues ? interpolateWidgetParams(base, variableValues) : base
	}, [resolvedTimeRange, request?.params, variableValues])

	// Stabilise the atom reference across renders. Atom.family already dedupes
	// by encoded key, but giving React the same Atom instance avoids any path
	// where useAtomValue / useAtomRefresh re-subscribe and drop an in-flight
	// fetch (the user-visible symptom: widgets stuck on the loading skeleton).
	const fetchAtom = useMemo(() => {
		if (
			disableReason !== null ||
			isStatic ||
			request === null ||
			!enabled ||
			waitingOnVariables ||
			(exceedsListCap && !narrowed)
		) {
			return disabledResultAtom<unknown, WidgetFetchError>()
		}
		return widgetFetchAtom({
			endpoint: request.endpoint,
			params: resolvedParams,
		})
	}, [
		disableReason,
		isStatic,
		request,
		resolvedParams,
		enabled,
		waitingOnVariables,
		exceedsListCap,
		narrowed,
	])

	const result = useRefreshableAtomValue(fetchAtom)

	const transform = dataSource?.transform

	const dataState: WidgetDataState = useMemo(() => {
		if (isStatic) {
			return { status: "ready", data: null } as const
		}
		// Paused (off-screen) tiles read as "loading", not "error" — the query is
		// simply deferred until the tile scrolls into view. Same for tiles whose
		// dashboard-variable references haven't resolved yet.
		if (!enabled || waitingOnVariables) {
			return { status: "loading" } as const
		}
		if (disableReason) {
			return { status: "error", message: disableReason } as const
		}
		if (exceedsListCap && !narrowed) {
			return {
				status: "error",
				kind: "range",
				title: `Range too wide for this list`,
				message: `Lists show individual records, so they cover at most ${formatRangeSeconds(MAX_LIST_RANGE_SECONDS)}. Charts on this dashboard are unaffected.`,
			} as const
		}
		return Result.builder(result)
			.onInitial(() => ({ status: "loading" }) as const)
			.onError((error) => {
				if (isExpectedEmptyDataError(error)) {
					return {
						status: "error",
						message: "No query data found in selected time range",
					} as const
				}
				const { title, message } = displayError(error)
				const kind = classifyWidgetErrorKind(error)
				return { status: "error", title, message, kind } as const
			})
			.onSuccess((rawData) => ({ status: "ready", data: applyTransform(rawData, transform) }) as const)
			.orElse(() => ({ status: "error", message: "Unknown error" }) as const)
	}, [result, transform, disableReason, isStatic, enabled, waitingOnVariables, exceedsListCap, narrowed])

	// Offered only while the tile is actually blocked, so the frame can render
	// the action without knowing anything about time ranges.
	const narrowRange = useMemo(
		() => (exceedsListCap && !narrowed ? () => setNarrowedToCap(true) : undefined),
		[exceedsListCap, narrowed],
	)

	return {
		dataState,
		narrowRange,
		/** Label for the narrowing action, e.g. "Show last 7 days". */
		narrowRangeLabel: `Show last ${formatRangeSeconds(MAX_LIST_RANGE_SECONDS)}`,
	}
}

export function useWidgetData(widget: DashboardWidget, enabled = true) {
	return useWidgetDataSource(widget.dataSource, enabled, widget.timeRange)
}

export const __testables = {
	applyTransform,
	filterHiddenSeriesRows,
	isSeriesNameHidden,
}
