import type { BaseComponentProps } from "@json-render/react"
import { cn } from "@maple/ui/utils"
import { formatDuration, formatErrorRate, formatNumber } from "@/lib/format"

interface ServiceTableProps {
	services: Array<{
		name: string
		throughput: number
		errorRate: number
		p50Ms: number
		p95Ms: number
		p99Ms: number
	}>
	dataVolume?: Array<{
		name: string
		traces: number
		logs: number
		metrics: number
	}>
}

export function ServiceTable({ props }: BaseComponentProps<ServiceTableProps>) {
	const { services } = props

	return (
		<div className="max-h-[300px] overflow-y-auto">
			<table className="w-full text-[11px]">
				<thead>
					<tr className="border-b border-border/40 text-left text-muted-foreground">
						<th className="pb-1 pr-2 font-medium">Service</th>
						<th className="pb-1 pr-2 font-medium text-right">Throughput</th>
						<th className="pb-1 pr-2 font-medium text-right">Error Rate</th>
						<th className="pb-1 pr-2 font-medium text-right">P50</th>
						<th className="pb-1 pr-2 font-medium text-right">P95</th>
						<th className="pb-1 font-medium text-right">P99</th>
					</tr>
				</thead>
				<tbody>
					{services.map((svc) => (
						<tr key={svc.name} className="border-b border-border/20 last:border-0">
							<td className="py-1 pr-2">
								<a href={`/services/${svc.name}`} className="text-primary hover:underline">
									{svc.name}
								</a>
							</td>
							<td className="py-1 pr-2 text-right font-mono text-muted-foreground">
								{formatNumber(svc.throughput)}
							</td>
							<td
								className={cn(
									"py-1 pr-2 text-right font-mono",
									svc.errorRate < 0.01 && "text-severity-info",
									svc.errorRate >= 0.01 && svc.errorRate < 0.05 && "text-severity-warn",
									svc.errorRate >= 0.05 && "text-severity-error",
								)}
							>
								{formatErrorRate(svc.errorRate)}
							</td>
							<td className="py-1 pr-2 text-right font-mono text-muted-foreground">
								{formatDuration(svc.p50Ms)}
							</td>
							<td className="py-1 pr-2 text-right font-mono text-muted-foreground">
								{formatDuration(svc.p95Ms)}
							</td>
							<td className="py-1 text-right font-mono text-muted-foreground">
								{formatDuration(svc.p99Ms)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
