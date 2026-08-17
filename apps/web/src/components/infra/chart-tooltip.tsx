import type { ReactNode } from "react"
import { formatValueWithUnit, type ChartUnit } from "./chart-utils"

/**
 * One row inside an infra chart tooltip: a colour swatch, the series label
 * (the "type" — e.g. "CPU usage", a container name, a mount point), and the
 * unit-formatted value. Recharts' `formatter` return value replaces the whole
 * tooltip row, so this restores both the label and a unit-bearing value that
 * the bare default would otherwise drop.
 */
export function InfraTooltipItem({
	color,
	label,
	value,
	unit,
}: {
	color: string
	// `ChartConfig` labels are typed as ReactNode; our infra labels are strings.
	label: ReactNode
	value: number
	unit: ChartUnit
}) {
	return (
		<>
			<div className="size-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
			<div className="flex flex-1 items-center justify-between gap-3 leading-none">
				<span className="text-muted-foreground">{label}</span>
				<span className="font-mono font-semibold tabular-nums text-foreground">
					{formatValueWithUnit(value, unit)}
				</span>
			</div>
		</>
	)
}
