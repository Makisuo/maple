import type { ChartConfig } from "../../ui/chart"
import { resolveSeriesColors } from "../../../lib/semantic-series-colors"

export function buildChartConfig(
	data: Record<string, unknown>[],
	nameKey = "name",
): { config: ChartConfig; data: Record<string, unknown>[] } {
	const config: ChartConfig = {}
	const names = data.map((item, i) => String(item[nameKey] ?? `item-${i}`))
	const colors = resolveSeriesColors(names)
	const coloredData = data.map((item, i) => {
		const name = names[i]
		const key = name.toLowerCase().replace(/[^a-z0-9]/g, "-")
		config[key] = { label: name, color: colors.get(name) }
		return { ...item, fill: `var(--color-${key})` }
	})
	return { config, data: coloredData }
}
