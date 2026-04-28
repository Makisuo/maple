import { Link } from "@tanstack/react-router"
import { cn } from "@maple/ui/utils"
import { formatDuration, formatErrorRate, formatNumber } from "@/lib/format"
import type { InlineServiceData } from "./types"

export function InlineService({ data }: { data: InlineServiceData }) {
	return (
		<Link
			to="/services/$serviceName"
			params={{ serviceName: data.name }}
			className="my-1 flex items-center gap-3 rounded-lg border border-border/40 bg-muted/30 px-3 py-2 text-[11px] transition-colors hover:bg-muted/60"
		>
			<span className="font-medium text-primary">{data.name}</span>
			{data.throughput != null && (
				<span className="text-[10px] text-muted-foreground">
					{formatNumber(data.throughput)} req/s
				</span>
			)}
			{data.errorRate != null && (
				<span
					className={cn(
						"font-mono text-[10px]",
						data.errorRate < 0.01 && "text-severity-info",
						data.errorRate >= 0.01 && data.errorRate < 0.05 && "text-severity-warn",
						data.errorRate >= 0.05 && "text-severity-error",
					)}
				>
					{formatErrorRate(data.errorRate)} err
				</span>
			)}
			{data.p99Ms != null && (
				<span className="ml-auto text-[10px] text-muted-foreground">
					P99: <span className="font-mono">{formatDuration(data.p99Ms)}</span>
				</span>
			)}
		</Link>
	)
}
