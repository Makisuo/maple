import type { ChartConfig } from "../../ui/chart"

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

export function buildChartConfig(
  data: Record<string, unknown>[],
  nameKey = "name"
): { config: ChartConfig; data: Record<string, unknown>[] } {
  const config: ChartConfig = {}
  const coloredData = data.map((item, i) => {
    const name = String(item[nameKey] ?? `item-${i}`)
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "-")
    const colorIndex = i % CHART_COLORS.length
    config[key] = { label: name, color: CHART_COLORS[colorIndex] }
    return { ...item, fill: `var(--color-${key})` }
  })
  return { config, data: coloredData }
}
