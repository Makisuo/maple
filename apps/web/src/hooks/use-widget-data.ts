import { useMemo } from "react"
import { Atom, Result } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Effect, Schedule, Schema } from "effect"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { serverFunctionMap } from "@/components/dashboard-builder/data-source-registry"
import type { DashboardWidget, WidgetDataSource } from "@/components/dashboard-builder/types"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import type { WidgetDataState } from "@/components/dashboard-builder/types"
import { encodeKey } from "@/lib/cache-key"
import { formatBackendError } from "@/lib/error-messages"
import { Cause, Exit } from "effect"

const unwrapEffectCause = (error: unknown): unknown => {
	if (Cause.isCause(error)) return Cause.squash(error)
	if (Exit.isExit(error)) {
		const found = Exit.isFailure(error) ? Cause.squash(error.cause) : undefined
		if (found !== undefined) return found
	}
	return error
}

const errorTag = (error: unknown): string | undefined => {
	if (typeof error !== "object" || error === null) return undefined
	const tag = (error as { _tag?: unknown })._tag
	return typeof tag === "string" ? tag : undefined
}

const DECODE_ERROR_TAGS = new Set([
	"TinybirdDecodeError",
	"@maple/http/errors/QueryEngineValidationError",
])

const classifyWidgetErrorKind = (input: unknown): "decode" | "runtime" => {
	const error = unwrapEffectCause(input)
	const directTag = errorTag(error)
	if (directTag && DECODE_ERROR_TAGS.has(directTag)) return "decode"
	if (typeof error === "object" && error !== null && "cause" in error) {
		const cause = (error as { cause?: unknown }).cause
		const causeTag = errorTag(cause)
		if (causeTag && DECODE_ERROR_TAGS.has(causeTag)) return "decode"
	}
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
		rows = [...rows].sort((a, b) => {
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

class WidgetDataAtomError extends Schema.TaggedErrorClass<WidgetDataAtomError>()("WidgetDataAtomError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown),
}) {}

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

const toWidgetDataAtomError = (error: unknown): unknown => {
	if (error instanceof WidgetDataAtomError) return error
	if (isTaggedBackendError(error)) return error
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

const widgetFetchFamily = Atom.family((key: string) =>
	Atom.make(
		Effect.try({
			try: () =>
				JSON.parse(key) as {
					endpoint: DashboardWidget["dataSource"]["endpoint"]
					params: Record<string, unknown>
				},
			catch: toWidgetDataAtomError,
		}).pipe(
			Effect.flatMap(({ endpoint, params }) => {
				const serverFn = serverFunctionMap[endpoint]
				if (!serverFn) {
					return Effect.fail(
						new WidgetDataAtomError({
							message: `Unknown endpoint: ${endpoint}`,
						}),
					)
				}

				return (serverFn({ data: params }) as Effect.Effect<unknown, unknown, never>).pipe(
					Effect.map((response) => {
						return (response as { data?: unknown })?.data ?? response
					}),
				)
			}),
			Effect.mapError(toWidgetDataAtomError),
			Effect.retry({
				times: 2,
				schedule: Schedule.exponential("500 millis"),
				while: (error) => !isExpectedEmptyDataError(error),
			}),
		),
	).pipe(Atom.setIdleTTL(120_000)),
)

const widgetFetchAtom = (input: {
	endpoint: DashboardWidget["dataSource"]["endpoint"]
	params: Record<string, unknown>
}) => widgetFetchFamily(encodeKey(input))

export function useWidgetData(widget: DashboardWidget) {
	const {
		state: { resolvedTimeRange },
	} = useDashboardTimeRange()

	const isStatic = widget.dataSource.endpoint === "markdown_static"
	const hasServerFn = !!serverFunctionMap[widget.dataSource.endpoint]

	const disableReason = isStatic
		? null
		: !resolvedTimeRange
			? "Unable to resolve dashboard time range"
			: !hasServerFn
				? `Unknown data source endpoint: ${widget.dataSource.endpoint}`
				: null

	const resolvedParams = useMemo(
		() =>
			resolvedTimeRange
				? interpolateParams(
						{
							...widget.dataSource.params,
							strategy: { enableEmptyRangeFallback: false },
							startTime: resolvedTimeRange.startTime,
							endTime: resolvedTimeRange.endTime,
						},
						resolvedTimeRange,
					)
				: {},
		[resolvedTimeRange, widget.dataSource.params],
	)

	// Stabilise the atom reference across renders. Atom.family already dedupes
	// by encoded key, but giving React the same Atom instance avoids any path
	// where useAtomValue / useAtomRefresh re-subscribe and drop an in-flight
	// fetch (the user-visible symptom: widgets stuck on the loading skeleton).
	const fetchAtom = useMemo(() => {
		if (disableReason !== null || isStatic) {
			return disabledResultAtom<unknown, WidgetDataAtomError>()
		}
		return widgetFetchAtom({
			endpoint: widget.dataSource.endpoint,
			params: resolvedParams,
		})
	}, [disableReason, isStatic, widget.dataSource.endpoint, resolvedParams])

	const result = useRefreshableAtomValue(fetchAtom)

	const transform = widget.dataSource.transform

	const dataState: WidgetDataState = useMemo(() => {
		if (isStatic) {
			return { status: "ready", data: null } as const
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
	}, [result, transform, disableReason, isStatic])

	return {
		dataState,
	}
}

export const __testables = {
	applyTransform,
	filterHiddenSeriesRows,
	isSeriesNameHidden,
}
