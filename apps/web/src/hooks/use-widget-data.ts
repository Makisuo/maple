import { useMemo } from "react"
import { Atom, Result } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Effect, Schedule, Schema } from "effect"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { useDashboardVariablesOptional } from "@/components/dashboard-builder/dashboard-variables-context"
import { getServerFunction } from "@/components/dashboard-builder/data-source-registry"
import {
	hasUnresolvedVariableRefs,
	interpolateWidgetParams,
} from "@/lib/dashboard-variables/interpolate"
import type { DashboardWidget, WidgetDataSource } from "@/components/dashboard-builder/types"

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
import type { WidgetDataState } from "@/components/dashboard-builder/types"
import { encodeKey } from "@/lib/cache-key"
import { formatBackendError } from "@/lib/error-messages"
import { Cause, Option } from "effect"
import { WarehouseDecodeError, type BackendError } from "@/api/warehouse/effect-utils"
import { QueryEngineValidationError } from "@maple/domain/http"

// An error means "the query input/response failed validation" (rather than a
// transient runtime failure) when it is one of these tagged validation errors,
// either directly or as the `cause` wrapped inside a `WidgetDataAtomError`.
const isDecodeError = (value: unknown): boolean =>
	value instanceof WarehouseDecodeError || value instanceof QueryEngineValidationError

// Pull the most meaningful error out of whatever `onError` / a Cause hands us:
// a flattened `Cause` yields its first failure; a bare error is returned as-is.
const extractError = (input: unknown): unknown =>
	Cause.isCause(input) ? Option.getOrElse(Cause.findErrorOption(input), () => input) : input

const classifyWidgetErrorKind = (input: unknown): "decode" | "runtime" => {
	const error = extractError(input)
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

class WidgetDataAtomError extends Schema.TaggedErrorClass<WidgetDataAtomError>()(
	"@maple/web/hooks/WidgetDataAtomError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Unknown),
	},
) {}

const isTaggedBackendError = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	typeof (error as { _tag: unknown })._tag === "string" &&
	(error as { _tag: string })._tag.startsWith("@maple/http/errors/")

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
// `WidgetDataAtomError` (parse / unknown-endpoint / unstructured failures) or a
// tagged `@maple/http/errors/*` backend error passed through unchanged so
// `formatBackendError` can match its specific tag.
type WidgetFetchError = WidgetDataAtomError | BackendError

const toWidgetDataAtomError = (error: unknown): WidgetFetchError => {
	if (error instanceof WidgetDataAtomError) return error
	if (isTaggedBackendError(error)) return error as BackendError
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
			try: () =>
				JSON.parse(key) as {
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
	Effect.mapError(toWidgetDataAtomError),
	Effect.retry({
		times: 2,
		schedule: Schedule.exponential("500 millis"),
		while: (error) => !isExpectedEmptyDataError(error),
	}),
)

const widgetFetchFamily = Atom.family((key: string) =>
	Atom.make(fetchWidgetData(key)).pipe(Atom.setIdleTTL(120_000)),
)

const widgetFetchAtom = (input: { endpoint: string; params: Record<string, unknown> }) =>
	widgetFetchFamily(encodeKey(input))

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
) {
	const {
		state: { resolvedTimeRange },
	} = useDashboardTimeRange()
	const variablesContext = useDashboardVariablesOptional()

	const isStatic = dataSource?.endpoint === "markdown_static"
	const hasServerFn = dataSource ? !!getServerFunction(dataSource.endpoint) : false

	const disableReason = !dataSource
		? "No data source configured"
		: isStatic
			? null
			: !resolvedTimeRange
				? "Unable to resolve dashboard time range"
				: !hasServerFn
					? `Unknown data source endpoint: ${dataSource.endpoint}`
					: null

	// A params blob referencing a defined dashboard variable whose value hasn't
	// resolved yet (query-variable options still loading, no default) must not
	// fire — a literal `$service` would reach the API. Mirrors the
	// `resolvedTimeRange` gate: the widget reads as "loading" until it settles.
	const waitingOnVariables = useMemo(
		() =>
			variablesContext !== null &&
			hasUnresolvedVariableRefs(
				dataSource?.params,
				variablesContext.variables.map((variable) => variable.name),
				variablesContext.values,
			),
		[dataSource?.params, variablesContext],
	)

	const variableValues = variablesContext?.values

	const resolvedParams = useMemo(() => {
		if (!resolvedTimeRange) return {}
		const base = interpolateParams(
			{
				...dataSource?.params,
				strategy: { enableEmptyRangeFallback: false },
				startTime: resolvedTimeRange.startTime,
				endTime: resolvedTimeRange.endTime,
			},
			resolvedTimeRange,
		)
		return variableValues ? interpolateWidgetParams(base, variableValues) : base
	}, [resolvedTimeRange, dataSource?.params, variableValues])

	// Stabilise the atom reference across renders. Atom.family already dedupes
	// by encoded key, but giving React the same Atom instance avoids any path
	// where useAtomValue / useAtomRefresh re-subscribe and drop an in-flight
	// fetch (the user-visible symptom: widgets stuck on the loading skeleton).
	const fetchAtom = useMemo(() => {
		if (disableReason !== null || isStatic || !dataSource || !enabled || waitingOnVariables) {
			return disabledResultAtom<unknown, WidgetFetchError>()
		}
		return widgetFetchAtom({
			endpoint: dataSource.endpoint,
			params: resolvedParams,
		})
	}, [disableReason, isStatic, dataSource, resolvedParams, enabled, waitingOnVariables])

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
		return Result.builder(result)
			.onInitial(() => ({ status: "loading" }) as const)
			.onError((error) => {
				if (isExpectedEmptyDataError(error)) {
					return {
						status: "error",
						message: "No query data found in selected time range",
					} as const
				}
				const { title, description } = formatBackendError(error)
				const kind = classifyWidgetErrorKind(error)
				return { status: "error", title, message: description, kind } as const
			})
			.onSuccess((rawData) => ({ status: "ready", data: applyTransform(rawData, transform) }) as const)
			.orElse(() => ({ status: "error", message: "Unknown error" }) as const)
	}, [result, transform, disableReason, isStatic, enabled, waitingOnVariables])

	return {
		dataState,
	}
}

export function useWidgetData(widget: DashboardWidget, enabled = true) {
	return useWidgetDataSource(widget.dataSource, enabled)
}

export const __testables = {
	applyTransform,
	filterHiddenSeriesRows,
	isSeriesNameHidden,
}
