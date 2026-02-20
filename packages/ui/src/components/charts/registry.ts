import { lazy } from "react"
import type { ChartRegistryEntry } from "./_shared/chart-types"
import {
  defaultBarData,
  multiBarData,
  areaTimeSeriesData,
  lineTimeSeriesData,
  multiLineData,
  partialLineData,
radarData,
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
  {
    id: "hatched-bar",
    name: "Hatched Bar",
    description: "Bar chart with hatched pattern fill",
    category: "bar",
    component: lazy(() =>
      import("./bar/hatched-bar-chart").then((m) => ({ default: m.HatchedBarChart }))
    ),
    sampleData: defaultBarData,
    tags: ["bar", "hatched", "pattern"],
  },
  {
    id: "highlighted-bar",
    name: "Highlighted Bar",
    description: "Bar chart with hover highlight effect",
    category: "bar",
    component: lazy(() =>
      import("./bar/highlighted-bar-chart").then((m) => ({ default: m.HighlightedBarChart }))
    ),
    sampleData: defaultBarData,
    tags: ["bar", "hover", "interactive", "highlight"],
  },
  {
    id: "duotone-bar",
    name: "Duotone Bar",
    description: "Bar chart with horizontal gradient split",
    category: "bar",
    component: lazy(() =>
      import("./bar/duotone-bar-chart").then((m) => ({ default: m.DuotoneBarChart }))
    ),
    sampleData: defaultBarData,
    tags: ["bar", "gradient", "duotone"],
  },
  {
    id: "gradient-bar",
    name: "Gradient Bar",
    description: "Bar chart with vertical gradient and cap",
    category: "bar",
    component: lazy(() =>
      import("./bar/gradient-bar-chart").then((m) => ({ default: m.GradientBarChart }))
    ),
    sampleData: defaultBarData,
    tags: ["bar", "gradient"],
  },
  {
    id: "glowing-bar",
    name: "Glowing Bar",
    description: "Stacked bar chart with glow filter",
    category: "bar",
    component: lazy(() =>
      import("./bar/glowing-bar-chart").then((m) => ({ default: m.GlowingBarChart }))
    ),
    sampleData: multiBarData,
    tags: ["bar", "glow", "stacked", "filter"],
  },
  {
    id: "default-multiple-bar",
    name: "Multiple Bar",
    description: "Grouped bar chart with multiple series",
    category: "bar",
    component: lazy(() =>
      import("./bar/default-multiple-bar-chart").then((m) => ({
        default: m.DefaultMultipleBarChart,
      }))
    ),
    sampleData: multiBarData,
    tags: ["bar", "multiple", "grouped"],
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
  {
    id: "gradient-rounded-area",
    name: "Gradient Rounded Area",
    description: "Smooth area chart with gradient fills",
    category: "area",
    component: lazy(() =>
      import("./area/gradient-rounded-area-chart").then((m) => ({
        default: m.GradientRoundedAreaChart,
      }))
    ),
    sampleData: areaTimeSeriesData,
    tags: ["area", "gradient", "smooth", "rounded"],
  },
  {
    id: "dotted-pattern-area",
    name: "Dotted Pattern Area",
    description: "Area chart with dotted pattern fill",
    category: "area",
    component: lazy(() =>
      import("./area/dotted-pattern-area-chart").then((m) => ({
        default: m.DottedPatternAreaChart,
      }))
    ),
    sampleData: areaTimeSeriesData,
    tags: ["area", "dotted", "pattern"],
  },
  {
    id: "bar-pattern-area",
    name: "Bar Pattern Area",
    description: "Area chart with hatched bar-style pattern",
    category: "area",
    component: lazy(() =>
      import("./area/bar-pattern-area-chart").then((m) => ({
        default: m.BarPatternAreaChart,
      }))
    ),
    sampleData: areaTimeSeriesData,
    tags: ["area", "hatched", "bar", "pattern"],
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
  {
    id: "dotted-multi-line",
    name: "Dotted Multi Line",
    description: "Multiple dotted lines with different colors",
    category: "line",
    component: lazy(() =>
      import("./line/dotted-multi-line-chart").then((m) => ({
        default: m.DottedMultiLineChart,
      }))
    ),
    sampleData: multiLineData,
    tags: ["line", "dotted", "multiple"],
  },
  {
    id: "glowing-line",
    name: "Glowing Line",
    description: "Line chart with glow filter effect",
    category: "line",
    component: lazy(() =>
      import("./line/glowing-line-chart").then((m) => ({ default: m.GlowingLineChart }))
    ),
    sampleData: lineTimeSeriesData,
    tags: ["line", "glow", "filter"],
  },
  {
    id: "pinging-dot",
    name: "Pinging Dot",
    description: "Line chart with animated pinging dot on last point",
    category: "line",
    component: lazy(() =>
      import("./line/pinging-dot-chart").then((m) => ({ default: m.PingingDotChart }))
    ),
    sampleData: lineTimeSeriesData,
    tags: ["line", "dot", "ping", "animated"],
  },
  {
    id: "number-dot-line",
    name: "Number Dot Line",
    description: "Line chart with value labels on dots",
    category: "line",
    component: lazy(() =>
      import("./line/number-dot-line-chart").then((m) => ({
        default: m.NumberDotLineChart,
      }))
    ),
    sampleData: lineTimeSeriesData,
    tags: ["line", "dot", "number", "label"],
  },
  {
    id: "partial-line",
    name: "Partial Line",
    description: "Line chart with solid and dashed segments",
    category: "line",
    component: lazy(() =>
      import("./line/partial-line-chart").then((m) => ({ default: m.PartialLineChart }))
    ),
    sampleData: partialLineData,
    tags: ["line", "partial", "forecast", "dashed"],
  },
  {
    id: "rainbow-glow-gradient-line",
    name: "Rainbow Glow Line",
    description: "Line chart with rainbow gradient and glow effect",
    category: "line",
    component: lazy(() =>
      import("./line/rainbow-glow-gradient-line-chart").then((m) => ({
        default: m.RainbowGlowGradientLineChart,
      }))
    ),
    sampleData: lineTimeSeriesData,
    tags: ["line", "rainbow", "glow", "gradient"],
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

  // Radar Charts
  {
    id: "stroke-radar",
    name: "Stroke Radar",
    description: "Radar chart with stroke styling",
    category: "radar",
    component: lazy(() =>
      import("./radar/stroke-radar-chart").then((m) => ({ default: m.StrokeRadarChart }))
    ),
    sampleData: radarData,
    tags: ["radar", "stroke"],
  },
  {
    id: "stroke-multiple-radar",
    name: "Stroke Multiple Radar",
    description: "Radar chart with multiple series",
    category: "radar",
    component: lazy(() =>
      import("./radar/stroke-multiple-radar-chart").then((m) => ({
        default: m.StrokeMultipleRadarChart,
      }))
    ),
    sampleData: radarData,
    tags: ["radar", "stroke", "multiple"],
  },
  {
    id: "glowing-stroke-radar",
    name: "Glowing Stroke Radar",
    description: "Radar chart with glow effect on stroke",
    category: "radar",
    component: lazy(() =>
      import("./radar/glowing-stroke-radar-chart").then((m) => ({
        default: m.GlowingStrokeRadarChart,
      }))
    ),
    sampleData: radarData,
    tags: ["radar", "glow", "stroke"],
  },
  {
    id: "glowing-multiple-stroke-radar",
    name: "Glowing Multiple Radar",
    description: "Multiple radar series with shared glow effect",
    category: "radar",
    component: lazy(() =>
      import("./radar/glowing-multiple-stroke-radar-chart").then((m) => ({
        default: m.GlowingMultipleStrokeRadarChart,
      }))
    ),
    sampleData: radarData,
    tags: ["radar", "glow", "stroke", "multiple"],
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
