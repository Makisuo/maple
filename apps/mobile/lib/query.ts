import { QueryClient } from "@tanstack/react-query"
import type { TimeRangeKey } from "./time-utils"
import type { DashboardWidget, LogsFilters, TraceFilters, WidgetTimeRange } from "./api"

const MINUTE_MS = 60_000

export const mobileQueryStaleTimes = {
  dashboardData: 60 * 1000,
  services: 60 * 1000,
  serviceDetail: 60 * 1000,
  traces: 30 * 1000,
  logs: 30 * 1000,
  facets: 5 * MINUTE_MS,
  dashboards: 10 * MINUTE_MS,
  widgetData: 2 * MINUTE_MS,
  spanHierarchy: 30 * MINUTE_MS,
} as const

export const mobileQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 30 * MINUTE_MS,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
})

type NormalizedQueryKeyPart =
  | null
  | string
  | number
  | boolean
  | NormalizedQueryKeyPart[]
  | { [key: string]: NormalizedQueryKeyPart }

export function normalizeQueryKeyPart(value: unknown): NormalizedQueryKeyPart {
  if (value == null) return null
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeQueryKeyPart(item))
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, normalizeQueryKeyPart(nestedValue)] as const)

    return Object.fromEntries(entries)
  }

  return String(value)
}

export function preservePreviousData<T>(previousData: T | undefined): T | undefined {
  return previousData
}

export function getQueryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error"
}

export const mobileQueryKeys = {
  dashboardData: (timeKey: TimeRangeKey) => ["dashboard-data", timeKey] as const,
  services: (timeKey: TimeRangeKey) => ["services", timeKey] as const,
  serviceDetail: (serviceName: string, timeKey: TimeRangeKey) =>
    ["service-detail", { serviceName, timeKey }] as const,
  traces: (timeKey: TimeRangeKey, filters?: TraceFilters) =>
    [
      "traces",
      {
        timeKey,
        filters: normalizeQueryKeyPart(filters ?? null),
      },
    ] as const,
  logs: (timeKey: TimeRangeKey, filters?: LogsFilters) =>
    [
      "logs",
      {
        timeKey,
        filters: normalizeQueryKeyPart(filters ?? null),
      },
    ] as const,
  tracesFacets: (timeKey: TimeRangeKey) => ["traces-facets", timeKey] as const,
  logsFacets: (timeKey: TimeRangeKey) => ["logs-facets", timeKey] as const,
  dashboards: () => ["dashboards"] as const,
  spanHierarchy: (traceId: string) => ["span-hierarchy", traceId] as const,
  widgetData: (widget: DashboardWidget, timeRange: WidgetTimeRange) =>
    [
      "widget-data",
      {
        id: widget.id,
        endpoint: widget.dataSource.endpoint,
        visualization: widget.visualization,
        timeRange: normalizeQueryKeyPart(timeRange),
        params: normalizeQueryKeyPart(widget.dataSource.params ?? null),
        transform: normalizeQueryKeyPart(widget.dataSource.transform ?? null),
      },
    ] as const,
}
