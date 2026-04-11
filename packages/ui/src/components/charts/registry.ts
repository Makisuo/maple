import { lazy } from "react"
import type { ChartRegistryEntry } from "./_shared/chart-types"
import {
  defaultBarData,
  areaTimeSeriesData,
  lineTimeSeriesData,
  latencyTimeSeriesData,
  throughputTimeSeriesData,
  apdexTimeSeriesData,
  errorRateTimeSeriesData,
} from "./_shared/sample-data"

export const chartRegistry: ChartRegistryEntry[] = [
  // Bar Charts
  {
    id: "default-bar",
    name: "Default Bar",
    description: "Bar chart with dotted SVG pattern background",
    category: "bar",
    component: lazy(() =>
      import("./bar/default-bar-chart").then((m) => ({ default: m.DefaultBarChart }))
    ),
    sampleData: defaultBarData,
    tags: ["bar", "basic", "dotted", "pattern"],
  },

  // Query Builder Bar
  {
    id: "query-builder-bar",
    name: "Query Builder Bar",
    description: "Dynamic multi-query bar chart for query builder widgets",
    category: "bar",
    component: lazy(() =>
      import("./bar/query-builder-bar-chart").then((m) => ({
        default: m.QueryBuilderBarChart,
      }))
    ),
    sampleData: latencyTimeSeriesData,
    tags: ["bar", "query-builder", "dynamic", "multi-query"],
  },

  // Area Charts
  {
    id: "gradient-area",
    name: "Gradient Area",
    description: "Stacked area chart with gradient fills",
    category: "area",
    component: lazy(() =>
      import("./area/gradient-area-chart").then((m) => ({ default: m.GradientAreaChart }))
    ),
    sampleData: areaTimeSeriesData,
    tags: ["area", "gradient", "stacked"],
  },

  // Query Builder Area
  {
    id: "query-builder-area",
    name: "Query Builder Area",
    description: "Dynamic multi-query area chart for query builder widgets",
    category: "area",
    component: lazy(() =>
      import("./area/query-builder-area-chart").then((m) => ({
        default: m.QueryBuilderAreaChart,
      }))
    ),
    sampleData: latencyTimeSeriesData,
    tags: ["area", "query-builder", "dynamic", "multi-query"],
  },

  // Line Charts
  {
    id: "dotted-line",
    name: "Dotted Line",
    description: "Line chart with dashed stroke",
    category: "line",
    component: lazy(() =>
      import("./line/dotted-line-chart").then((m) => ({ default: m.DottedLineChart }))
    ),
    sampleData: lineTimeSeriesData,
    tags: ["line", "dotted", "dashed"],
  },
  {
    id: "query-builder-line",
    name: "Query Builder Line",
    description: "Dynamic multi-query line chart for query builder widgets",
    category: "line",
    component: lazy(() =>
      import("./line/query-builder-line-chart").then((m) => ({
        default: m.QueryBuilderLineChart,
      }))
    ),
    sampleData: latencyTimeSeriesData,
    tags: ["line", "query-builder", "dynamic", "multi-query"],
  },

  // Service Charts
  {
    id: "latency-line",
    name: "Latency Line",
    description: "P99/P95/P50 latency percentiles over time",
    category: "line",
    component: lazy(() =>
      import("./line/latency-line-chart").then((m) => ({ default: m.LatencyLineChart }))
    ),
    sampleData: latencyTimeSeriesData,
    tags: ["line", "latency", "percentile", "service"],
  },
  {
    id: "throughput-area",
    name: "Throughput Area",
    description: "Request throughput over time",
    category: "area",
    component: lazy(() =>
      import("./area/throughput-area-chart").then((m) => ({ default: m.ThroughputAreaChart }))
    ),
    sampleData: throughputTimeSeriesData,
    tags: ["area", "throughput", "service"],
  },
  {
    id: "apdex-area",
    name: "Apdex Area",
    description: "Apdex score over time (0-1)",
    category: "area",
    component: lazy(() =>
      import("./area/apdex-area-chart").then((m) => ({ default: m.ApdexAreaChart }))
    ),
    sampleData: apdexTimeSeriesData,
    tags: ["area", "apdex", "service"],
  },
  {
    id: "error-rate-area",
    name: "Error Rate Area",
    description: "Error rate percentage over time",
    category: "area",
    component: lazy(() =>
      import("./area/error-rate-area-chart").then((m) => ({ default: m.ErrorRateAreaChart }))
    ),
    sampleData: errorRateTimeSeriesData,
    tags: ["area", "error", "rate", "service"],
  },
]

export function getChartById(id: string): ChartRegistryEntry | undefined {
  return chartRegistry.find((c) => c.id === id)
}

export function getChartsByCategory(category: string): ChartRegistryEntry[] {
  return chartRegistry.filter((c) => c.category === category)
}

export function searchCharts(query: string): ChartRegistryEntry[] {
  const lower = query.toLowerCase()
  return chartRegistry.filter(
    (c) =>
      c.name.toLowerCase().includes(lower) ||
      c.description.toLowerCase().includes(lower) ||
      c.tags.some((t) => t.includes(lower))
  )
}
