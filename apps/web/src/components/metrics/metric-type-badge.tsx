import { Badge } from "@maple/ui/components/ui/badge"

const metricTypeConfig: Record<string, { label: string; className: string }> = {
	sum: {
		label: "Sum",
		className: "bg-chart-p50/15 text-chart-p50",
	},
	gauge: {
		label: "Gauge",
		className: "bg-severity-info/15 text-severity-info",
	},
	histogram: {
		label: "Histogram",
		className: "bg-chart-4/15 text-chart-4",
	},
	exponential_histogram: {
		label: "Exp Hist",
		className: "bg-primary/15 text-primary",
	},
}

interface MetricTypeBadgeProps {
	type: string
}

export function MetricTypeBadge({ type }: MetricTypeBadgeProps) {
	const config = metricTypeConfig[type] ?? {
		label: type,
		className: "bg-muted text-muted-foreground",
	}

	return (
		<Badge variant="secondary" className={config.className}>
			{config.label}
		</Badge>
	)
}
