import { useMemo, useState } from "react"
import { dataSourceTransform, type WidgetDataSourceTransformSchema } from "@maple/widgets/dashboard"
import { Atom, Result } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Effect, Schedule, Schema } from "effect"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { useDashboardVariablesOptional } from "@/components/dashboard-builder/dashboard-variables-context"
import { useWidgetTimeRangeOverride } from "@/components/dashboard-builder/widgets/widget-time-range-context"
import { getServerFunction, toWidgetRequest } from "@/components/dashboard-builder/data-source-registry"
import { hasUnresolvedVariableRefs, planWidgetRequest } from "@maple/query-engine"
import type { DashboardWidget, TimeRange, WidgetDataSource } from "@/components/dashboard-builder/types"

/**
 * Was a structural stand-in, back when a widget's own data source narrowed
 * `endpoint` to the registry key union while the JSON-decoded
 * `display.sparkline.dataSource` typed it as a bare `string` — so neither was
 * assignable to the other and both had to be assignable to a third thing.
 *
 * v3 removed the discrepancy: both are the same union now. Kept as an alias only
 * so the sparkline call sites keep reading as "any data source, not necessarily
 * this widget's own".
 */
export type WidgetDataSourceLike = WidgetDataSource
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
import {
	MAX_LIST_RANGE_SECONDS,
	formatRangeSeconds,
	formatWarehouseDateTime,
	parseWarehouseDateTime,
} from "@maple/query-engine"

// An error means "the query input/response failed validation" (rather than a
// transient runtime failure) when it is one of these tagged validation errors,
// either directly or as the `cause` wrapped inside a `WidgetDataAtomError`.
const isDecodeError = (value: unknown): boolean =>
	value instanceof WarehouseDecodeError || value instanceof QueryEngineValidationError

// Pull the most meaningful error out of whatever `onError` / a Cause hands us:
// a flattened `Cause` yields its first failure; a bare error is returned as-is.
const extractError = <E>(input: E | Cause.Cause<E>): E | Cause.Cause<E> =>
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
	baseNames: ReadonlyArray<string>,
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

/**
 * Collapse, remap and cap the rows a query returned, per the widget's stored
 * transform.
 *
 * Exported because both data paths need it. It runs client-side by design —
 * the share redaction seam keeps `transform` on the wire for exactly this
 * reason while dropping everything that describes the query — so a shared board
 * has to apply it too, or a stat whose `reduceToValue` never runs renders its
 * whole result set where a single number belongs.
 */
export function applyTransform(
	// react-doctor-disable-next-line typescript/no-explicit-any -- This legacy transform boundary accepts heterogeneous query payloads and narrows before keyed reads.
	data: any,
	// The readonly schema type, not the app's deep-mutable `WidgetDataSource`
	// alias: this only reads the transform, and `dataSourceTransform` hands back
	// a live slice of the stored document that nothing here may write to.
	transform: typeof WidgetDataSourceTransformSchema.Type | undefined,
	// react-doctor-disable-next-line typescript/no-explicit-any -- Transforms intentionally return either row collections or scalar aggregations for the renderer.
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
			const mapped: Record<string, unknown> = { ...row } satisfies Record<string, unknown>
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

/**
 * A raw fetch response turned into what a visualization renders: the `{ data }`
 * envelope every warehouse server function — and the share API, which returns
 * the same functions' output — wraps its rows in is unwrapped (anything else, a
 * bare array or a scalar summary, passes through), then the widget's stored
 * transform is applied.
 *
 * Exported and used by *both* data paths on purpose. The share hook used to
 * store the envelope as-is and only the transform happened to unwrap it — so
 * stat tiles worked while every chart on a shared board got an object where an
 * array belongs and drew its sample data instead. There is exactly one
 * definition of "ready data" now; a renderer cannot tell which path fed it.
 */
export function toReadyWidgetData(
	response: unknown,
	transform: typeof WidgetDataSourceTransformSchema.Type | undefined,
	// react-doctor-disable-next-line typescript/no-explicit-any -- Same boundary as `applyTransform`: rows or a scalar aggregation, narrowed by the renderer.
): any {
	const envelope = response as { data?: unknown } | null | undefined
	return applyTransform(envelope?.data ?? response, transform)
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

/**
 * A successful response that carried no rows.
 *
 * `getQueryBuilderTimeseries` used to *fail* on an empty window, which is what
 * put "No query data found in selected time range" on the error path here. It
 * now answers with an empty envelope, so the emptiness has to be recognised on
 * the success path instead — otherwise a stat tile would format a transformed
 * empty array (a `sum` of nothing is `0`) as a real reading.
 */
const isEmptyDataEnvelope = (raw: unknown): boolean => {
	if (typeof raw !== "object" || raw === null || !("data" in raw)) return false
	return Array.isArray(raw.data) && raw.data.length === 0
}

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

const WidgetDataKey = Schema.fromJsonString(
	Schema.Struct({
		endpoint: Schema.String,
		params: Schema.Record(Schema.String, Schema.Unknown),
	}),
)

const fetchWidgetData = Effect.fnUntraced(
	function* (key: string) {
		// The key is org-scoped; only the payload after the separator is JSON.
		const parsed = yield* Schema.decodeUnknownEffect(WidgetDataKey)(orgScopedKeyPayload(key)).pipe(
			Effect.mapError(toWidgetDataAtomError),
		)

		const serverFn = getServerFunction(parsed.endpoint)
		if (!serverFn) {
			return yield* new WidgetDataAtomError({
				message: `Unknown endpoint: ${parsed.endpoint}`,
			})
		}

		return yield* serverFn({ data: parsed.params })
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
export interface WidgetDataOptions {
	/**
	 * How many points the tile can display — its rendered pixel width (a bar
	 * chart divides by its minimum bar width). Sent only on timeseries fetches,
	 * where it switches the auto bucket to the width model (Grafana's
	 * `$__interval`); omitted, the fixed 100-point policy applies. Part of the
	 * cache key, so quantize it (`useWidgetMaxDataPoints`) before passing it in.
	 */
	readonly maxDataPoints?: number
}

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
	options?: WidgetDataOptions,
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

	const variablesContext = useDashboardVariablesOptional()
	const variableValues = variablesContext?.values

	// The whole request — window, macros, variables, strategy, list-cap flag —
	// comes out of the one planner the share API also runs, so a board and its
	// share link execute the same query. This hook only adds what the browser
	// alone knows: whether the tile is on screen, whether variables have loaded,
	// and the viewer's opt-in list narrowing below.
	const plan = useMemo(
		() =>
			request === null || dashboardTimeRange === null
				? null
				: planWidgetRequest({
						request,
						dashboardWindow: dashboardTimeRange,
						...(override === undefined ? undefined : { widgetTimeRange: override }),
						...(variableValues === undefined ? undefined : { variableValues }),
						...(options?.maxDataPoints === undefined
							? undefined
							: { maxDataPoints: options.maxDataPoints }),
					}),
		// Keyed on the serialized override, not its identity: the dashboard object
		// is rebuilt on every optimistic write, and re-planning an unchanged
		// override would hand every pinned tile fresh params and refetch it.
		// `dashboardTimeRange` stays in the deps so a manual reload or auto-refresh
		// (which gives it a new identity) rebases a relative override against "now"
		// as well.
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- `overrideKey` stands in for `override` by value.
		[request, dashboardTimeRange, overrideKey, variableValues, options?.maxDataPoints],
	)

	// A list-kind tile on a window wider than the engine's list cap. Detected
	// here rather than left to the API so the tile never fires a request that is
	// certain to 400 (and never burns the fetch's two retries on it).
	const exceedsListCap = plan?.kind === "request" && plan.exceedsListCap

	// Opt-in, per-tile, not persisted: the viewer can pull just this tile back to
	// the cap without touching the dashboard's range or needing write access.
	const [narrowedToCap, setNarrowedToCap] = useState(false)
	const narrowed = narrowedToCap && exceedsListCap

	// Narrowing re-plans over the capped window (no widget override: the cap is
	// measured from the window the tile actually resolved to).
	const executed = useMemo(() => {
		if (!narrowed || plan === null || plan.kind !== "request" || request === null) return plan
		const endMs = parseWarehouseDateTime(plan.window.endTime)
		return planWidgetRequest({
			request,
			dashboardWindow: {
				startTime: formatWarehouseDateTime(endMs - MAX_LIST_RANGE_SECONDS * 1000),
				endTime: plan.window.endTime,
			},
			...(variableValues === undefined ? undefined : { variableValues }),
			...(options?.maxDataPoints === undefined ? undefined : { maxDataPoints: options.maxDataPoints }),
		})
	}, [narrowed, plan, request, variableValues, options?.maxDataPoints])

	const isStatic = request?.endpoint === "markdown_static"
	const hasServerFn = request !== null && !!getServerFunction(request.endpoint)

	const disableReason = !dataSource
		? "No data source configured"
		: request === null
			? "Unsupported data source"
			: isStatic
				? null
				: dashboardTimeRange === null
					? "Unable to resolve dashboard time range"
					: executed?.kind === "disabled"
						? "Unable to resolve this widget's time range"
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

	const resolvedParams = useMemo(() => (executed?.kind === "request" ? executed.params : {}), [executed])

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

	const transform = dataSourceTransform(dataSource)

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
			.onSuccess((rawData) =>
				isEmptyDataEnvelope(rawData)
					? // Same muted "No data" frame the empty-window failure used to
						// produce; `WidgetFrame` keys off this exact message.
						({ status: "error", message: "No query data found in selected time range" } as const)
					: ({ status: "ready", data: toReadyWidgetData(rawData, transform) } as const),
			)
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

export function useWidgetData(widget: DashboardWidget, enabled = true, options?: WidgetDataOptions) {
	return useWidgetDataSource(widget.dataSource, enabled, widget.timeRange, options)
}

export const __testables = {
	applyTransform,
	isEmptyDataEnvelope,
	filterHiddenSeriesRows,
	isSeriesNameHidden,
}
