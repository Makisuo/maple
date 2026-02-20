import { Badge } from "@maple/ui/components/ui/badge"

const metricTypeConfig: Record<string, { label: string; className: string }> = {
  sum: {
    label: "Sum",
    className: "bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400",
  },
  gauge: {
    label: "Gauge",
    className: "bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400",
  },
  histogram: {
    label: "Histogram",
    className: "bg-purple-500/10 text-purple-600 dark:bg-purple-400/10 dark:text-purple-400",
  },
  exponential_histogram: {
    label: "Exp Hist",
    className: "bg-orange-500/10 text-orange-600 dark:bg-orange-400/10 dark:text-orange-400",
  },
}

interface MetricTypeBadgeProps {
  type: string
}

export function MetricTypeBadge({ type }: MetricTypeBadgeProps) {
  const config = metricTypeConfig[type] ?? {
    label: type,
    className: "bg-gray-500/10 text-gray-600 dark:bg-gray-400/10 dark:text-gray-400",
  }

  return (
    <Badge variant="secondary" className={config.className}>
      {config.label}
    </Badge>
  )
}
