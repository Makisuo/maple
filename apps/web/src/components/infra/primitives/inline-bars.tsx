import { cn } from "@maple/ui/lib/utils"
import { formatPercent, severityLevel, type SeverityLevel } from "../format"

const BAR_FILL: Record<SeverityLevel, string> = {
	ok: "bg-[var(--severity-info)]",
	warn: "bg-[var(--severity-warn)]",
	crit: "bg-[var(--severity-error)]",
}

const VALUE_TONE: Record<SeverityLevel, string> = {
	ok: "text-foreground/75",
	warn: "text-[var(--severity-warn)]",
	crit: "text-[var(--severity-error)]",
}

const ROWS = [
	{ key: "cpu", label: "CPU" },
	{ key: "mem", label: "Mem" },
	{ key: "dsk", label: "Dsk" },
] as const

interface InlineMetricBarsProps {
	cpu: number
	memory: number
	disk: number
	className?: string
}

export function InlineMetricBars({ cpu, memory, disk, className }: InlineMetricBarsProps) {
	const values = { cpu, mem: memory, dsk: disk }
	return (
		<div className={cn("flex flex-col gap-[3px]", className)}>
			{ROWS.map((row) => {
				const raw = values[row.key]
				const safe = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
				const level = severityLevel(safe)
				return (
					<div key={row.key} className="flex items-center gap-2 leading-none">
						<span className="w-7 shrink-0 font-mono text-[10px] text-muted-foreground/70">
							{row.label}
						</span>
						<div className="relative h-[4px] flex-1 overflow-hidden rounded-[1px] bg-muted/50">
							<div
								className={cn(
									"absolute inset-y-0 left-0 transition-[width] duration-500 ease-out",
									BAR_FILL[level],
								)}
								style={{ width: `${Math.max(safe * 100, safe > 0 ? 2 : 0)}%` }}
							/>
						</div>
						<span
							className={cn(
								"w-10 shrink-0 text-right font-mono text-[11px] tabular-nums",
								VALUE_TONE[level],
							)}
						>
							{formatPercent(raw)}
						</span>
					</div>
				)
			})}
		</div>
	)
}
