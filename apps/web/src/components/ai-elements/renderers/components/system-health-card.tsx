import type { BaseComponentProps } from "@json-render/react"
import { cn } from "@maple/ui/utils"
import { formatDuration, formatErrorRate, formatNumber } from "@/lib/format"

interface SystemHealthCardProps {
	serviceCount: number
	totalSpans: number
	totalErrors: number
	errorRate: number
	affectedServicesCount: number
	latency: { p50Ms: number; p95Ms: number }
	topErrors: Array<{
		errorType: string
		count: number
		affectedServicesCount: number
	}>
}

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
	return (
		<div className="rounded border border-border/40 px-2 py-1.5">
			<p className="text-[10px] text-muted-foreground">{label}</p>
			<p className={cn("font-mono text-sm font-medium", color)}>{value}</p>
		</div>
	)
}

export function SystemHealthCard({ props }: BaseComponentProps<SystemHealthCardProps>) {
	const { serviceCount, totalSpans, totalErrors, errorRate, latency, topErrors } = props

	return (
		<div className="space-y-2">
			<div className="grid grid-cols-3 gap-1.5">
				<StatCell label="Services" value={formatNumber(serviceCount)} />
				<StatCell label="Total Spans" value={formatNumber(totalSpans)} />
				<StatCell
					label="Total Errors"
					value={formatNumber(totalErrors)}
					color={totalErrors > 0 ? "text-severity-error" : undefined}
				/>
				<StatCell
					label="Error Rate"
					value={formatErrorRate(errorRate)}
					color={
						errorRate >= 0.05
							? "text-severity-error"
							: errorRate >= 0.01
								? "text-severity-warn"
								: "text-severity-info"
					}
				/>
				<StatCell label="P50 Latency" value={formatDuration(latency.p50Ms)} />
				<StatCell label="P95 Latency" value={formatDuration(latency.p95Ms)} />
			</div>
			{topErrors.length > 0 && (
				<div className="space-y-1">
					<p className="text-[10px] font-medium text-muted-foreground">Top Errors</p>
					{topErrors.slice(0, 5).map((err) => (
						<div key={err.errorType} className="flex items-center gap-2 text-[11px]">
							<span className="min-w-0 flex-1 truncate text-severity-error">
								{err.errorType}
							</span>
							<span className="shrink-0 font-mono text-muted-foreground">{err.count}</span>
						</div>
					))}
				</div>
			)}
		</div>
	)
}
