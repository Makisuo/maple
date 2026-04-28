import { cn } from "@maple/ui/lib/utils"
import { formatPercent, severityLevel, type SeverityLevel } from "./format"

interface UsageBarProps {
	fraction: number
	className?: string
	showValue?: boolean
}

const FILL_BY_LEVEL: Record<SeverityLevel, string> = {
	ok: "bg-[var(--severity-info)]",
	warn: "bg-[var(--severity-warn)]",
	crit: "bg-[var(--severity-error)]",
}

const VALUE_BY_LEVEL: Record<SeverityLevel, string> = {
	ok: "text-foreground/80",
	warn: "text-[var(--severity-warn)]",
	crit: "text-[var(--severity-error)]",
}

export function UsageBar({ fraction, className, showValue = true }: UsageBarProps) {
	const safe = Number.isFinite(fraction) ? fraction : 0
	const clamped = Math.max(0, Math.min(1, safe))
	const level = severityLevel(clamped)

	return (
		<div className={cn("flex items-center gap-2.5", className)}>
			<div className="relative h-[6px] flex-1 overflow-hidden rounded-[1px] bg-muted/50">
				<div
					className={cn("h-full transition-[width] duration-500 ease-out", FILL_BY_LEVEL[level])}
					style={{ width: `${Math.max(clamped * 100, clamped > 0 ? 2 : 0)}%` }}
				/>
			</div>
			{showValue && (
				<span
					className={cn(
						"font-mono text-[11px] tabular-nums w-10 text-right",
						VALUE_BY_LEVEL[level],
					)}
				>
					{formatPercent(fraction)}
				</span>
			)}
		</div>
	)
}
