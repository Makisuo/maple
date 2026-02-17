import { useMemo } from "react"
import { Atom, Result, useAtomValue } from "@effect-atom/atom-react"
import { Effect, Schedule, Schema } from "effect"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { useDashboardVariables } from "@/components/dashboard-builder/dashboard-providers"
import { serverFunctionMap } from "@/components/dashboard-builder/data-source-registry"
import type { DashboardWidget, WidgetDataSource } from "@/components/dashboard-builder/types"
import { relativeToAbsolute } from "@/lib/time-utils"
import type { TimeRange } from "@/components/dashboard-builder/types"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import type { WidgetDataState } from "@/components/dashboard-builder/types"

function resolveTimeRange(timeRange: TimeRange): {
  startTime: string
  endTime: string
} | null {
  if (timeRange.type === "absolute") {
    return { startTime: timeRange.startTime, endTime: timeRange.endTime }
  }
  return relativeToAbsolute(timeRange.value)
}

function interpolateParams(
  params: Record<string, unknown>,
  variables: Map<string, string | string[]>,
  resolvedTime: { startTime: string; endTime: string }
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.startsWith("$")) {
      const varName = value.slice(1)

      if (varName === "__startTime") {
        result[key] = resolvedTime.startTime
      } else if (varName === "__endTime") {
        result[key] = resolvedTime.endTime
      } else {
        const varValue = variables.get(varName)
        // If includeAll is active and value is undefined, skip the param (no filter)
        if (varValue !== undefined) {
          result[key] = varValue
        }
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

class WidgetDataAtomError extends Schema.TaggedError<WidgetDataAtomError>()("WidgetDataAtomError", {
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

function normalizeForKey(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(normalizeForKey)
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))

  const normalized: Record<string, unknown> = {}
  for (const [key, entryValue] of entries) {
    normalized[key] = normalizeForKey(entryValue)
  }

  return normalized
}

function encodeKey(value: unknown): string {
  const normalized = normalizeForKey(value)
  return JSON.stringify(normalized === undefined ? null : normalized)
}

async function parseErrorField<Output>(output: Output): Promise<Output> {
  if (output && typeof output === "object" && "error" in output) {
    const errorValue = (output as { error?: unknown }).error
    if (typeof errorValue === "string" && errorValue.length > 0) {
      throw new WidgetDataAtomError({
        message: errorValue,
      })
    }
  }

  return output
}

const widgetDataResultFamily = Atom.family((key: string) =>
  Atom.make(
    Effect.tryPromise({
      try: async () => {
        const {
          endpoint,
          params,
          transform,
        } = JSON.parse(key) as {
          endpoint: DashboardWidget["dataSource"]["endpoint"]
          params: Record<string, unknown>
          transform: WidgetDataSource["transform"]
        }

        const serverFn = serverFunctionMap[endpoint]
        if (!serverFn) {
          throw new WidgetDataAtomError({
            message: `Unknown endpoint: ${endpoint}`,
          })
        }

        const response = await parseErrorField(await serverFn({ data: params }))
        const rawData = response?.data ?? response
        return applyTransform(rawData, transform)
      },
      catch: toWidgetDataAtomError,
    }).pipe(
      Effect.retry(Schedule.recurs(1)),
    ),
  ).pipe(Atom.setIdleTTL(30_000)),
)

const widgetDataResultAtom = (input: {
  endpoint: DashboardWidget["dataSource"]["endpoint"]
  params: Record<string, unknown>
  transform: WidgetDataSource["transform"]
}) => widgetDataResultFamily(encodeKey(input))

export function useWidgetData(widget: DashboardWidget) {
  const dashboardTimeRange = useDashboardTimeRange()
  const variables = useDashboardVariables()

  const effectiveTimeRange =
    widget.timeRangeOverride ?? dashboardTimeRange.state.timeRange
  const resolvedTime = resolveTimeRange(effectiveTimeRange)

  const hasServerFn = !!serverFunctionMap[widget.dataSource.endpoint]

  const resolvedParams = resolvedTime
    ? interpolateParams(
        {
          startTime: resolvedTime.startTime,
          endTime: resolvedTime.endTime,
          ...widget.dataSource.params,
        },
        variables.state.values,
        resolvedTime
      )
    : {}

  const result = useAtomValue(
    resolvedTime && hasServerFn
      ? widgetDataResultAtom({
          endpoint: widget.dataSource.endpoint,
          params: resolvedParams,
          transform: widget.dataSource.transform,
        })
      : disabledResultAtom(),
  )

  const dataState: WidgetDataState = useMemo(
    () =>
      Result.builder(result)
        .onInitial(() => ({ status: "loading" } as const))
        .onError(() => ({ status: "error" } as const))
        .onSuccess((data) => ({ status: "ready", data } as const))
        .orElse(() => ({ status: "error" } as const)),
    [result]
  )

  return {
    dataState,
  }
}
