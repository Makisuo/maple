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

function interpolateParams(
  params: Record<string, unknown>,
  resolvedTime: { startTime: string; endTime: string }
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
  transform: WidgetDataSource["transform"]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (!transform || !data) return data

  // Handle both { data: [...] } and raw array responses
  let rows = Array.isArray(data) ? data : data.data
  if (!Array.isArray(rows)) return data

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
        for (const [, val] of Object.entries(series)) {
          flatRows.push({ ...row, [valueField]: val })
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
    return denominator > 0 ? (numerator / denominator) : 0
  }

  // reduceToValue: collapse rows to a single value
  if (transform.reduceToValue) {
    const { field, aggregate = "first" } = transform.reduceToValue
    if (rows.length === 0) return 0

    const resolveField = (): string | null => {
      if (
        rows.some(
          (row: Record<string, unknown>) =>
            typeof row[field] === "number" || typeof row[field] === "string"
        )
      ) {
        return field
      }

      const firstNumericField = Object.entries(rows[0] as Record<string, unknown>).find(
        ([key, value]) => key !== "bucket" && typeof value === "number"
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
          0
        )
      case "count":
        return rows.length
      case "avg": {
        const sum = rows.reduce(
          (acc: number, row: Record<string, unknown>) =>
            acc + Number(row[resolvedField ?? ""] ?? 0),
          0
        )
        return sum / rows.length
      }
      case "max":
        return Math.max(
          ...rows.map((r: Record<string, unknown>) =>
            Number(r[resolvedField ?? ""] ?? 0)
          )
        )
      case "min":
        return Math.min(
          ...rows.map((r: Record<string, unknown>) =>
            Number(r[resolvedField ?? ""] ?? 0)
          )
        )
    }
  }

  return rows
}

class WidgetDataAtomError extends Schema.TaggedErrorClass<WidgetDataAtomError>()("WidgetDataAtomError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

const toWidgetDataAtomError = (error: unknown): WidgetDataAtomError => {
  if (error instanceof WidgetDataAtomError) return error
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
      Effect.retry(Schedule.exponential("500 millis").pipe(Schedule.compose(Schedule.recurs(2)))),
    ),
  ).pipe(Atom.setIdleTTL(120_000)),
)

const widgetFetchAtom = (input: {
  endpoint: DashboardWidget["dataSource"]["endpoint"]
  params: Record<string, unknown>
}) => widgetFetchFamily(encodeKey(input))

export function useWidgetData(widget: DashboardWidget) {
  const { state: { resolvedTimeRange } } = useDashboardTimeRange()

  const hasServerFn = !!serverFunctionMap[widget.dataSource.endpoint]

  const resolvedParams = resolvedTimeRange
    ? interpolateParams(
        {
          ...widget.dataSource.params,
          strategy: { enableEmptyRangeFallback: false },
          startTime: resolvedTimeRange.startTime,
          endTime: resolvedTimeRange.endTime,
        },
        resolvedTimeRange
      )
    : {}

  const result = useRefreshableAtomValue(
    resolvedTimeRange && hasServerFn
      ? widgetFetchAtom({
          endpoint: widget.dataSource.endpoint,
          params: resolvedParams,
        })
      : disabledResultAtom<unknown, WidgetDataAtomError>(),
  )

  const transform = widget.dataSource.transform

  const dataState: WidgetDataState = useMemo(
    () =>
      Result.builder(result)
        .onInitial(() => ({ status: "loading" } as const))
        .onError((error) => {
          const msg = error instanceof Error ? error.message : error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : String(error)
          return { status: "error", message: msg } as const
        })
        .onSuccess((rawData) => ({ status: "ready", data: applyTransform(rawData, transform) } as const))
        .orElse(() => ({ status: "error", message: "Unknown error" } as const)),
    [result, transform]
  )

  return {
    dataState,
  }
}
