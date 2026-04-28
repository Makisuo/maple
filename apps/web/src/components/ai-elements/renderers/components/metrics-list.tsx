import type { BaseComponentProps } from "@json-render/react"
import { Badge } from "@maple/ui/components/ui/badge"
import { formatNumber } from "@/lib/format"

interface MetricsListProps {
	summary: Array<{
		metricType: string
		metricCount: number
		dataPointCount: number
	}>
	metrics: Array<{
		metricName: string
		metricType: string
		serviceName: string
		metricUnit: string
		dataPointCount: number
	}>
}

export function MetricsList({ props }: BaseComponentProps<MetricsListProps>) {
	const { summary, metrics } = props

	return (
		<div className="space-y-2">
			{summary.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{summary.map((s) => (
						<div key={s.metricType} className="flex items-center gap-1 text-[11px]">
							<Badge variant="secondary" className="text-[10px]">
								{s.metricType}
							</Badge>
							<span className="text-muted-foreground">
								{s.metricCount} metrics, {formatNumber(s.dataPointCount)} points
							</span>
						</div>
					))}
				</div>
			)}
			<div className="max-h-[300px] overflow-y-auto">
				<table className="w-full text-[11px]">
					<thead>
						<tr className="border-b border-border/40 text-left text-muted-foreground">
							<th className="pb-1 pr-2 font-medium">Name</th>
							<th className="pb-1 pr-2 font-medium">Type</th>
							<th className="pb-1 pr-2 font-medium">Service</th>
							<th className="pb-1 pr-2 font-medium">Unit</th>
							<th className="pb-1 font-medium text-right">Data Points</th>
						</tr>
					</thead>
					<tbody>
						{metrics.map((m, i) => (
							<tr
								key={`${m.metricName}-${i}`}
								className="border-b border-border/20 last:border-0"
							>
								<td className="max-w-[180px] truncate py-1 pr-2 font-mono">{m.metricName}</td>
								<td className="py-1 pr-2">
									<Badge variant="secondary" className="text-[10px]">
										{m.metricType}
									</Badge>
								</td>
								<td className="py-1 pr-2 text-muted-foreground">{m.serviceName}</td>
								<td className="py-1 pr-2 text-muted-foreground">{m.metricUnit || "-"}</td>
								<td className="py-1 text-right font-mono text-muted-foreground">
									{formatNumber(m.dataPointCount)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	)
}
