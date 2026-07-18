import { Result, useAtomValue } from "@/lib/effect-atom"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { MetricTypeBadge } from "./metric-type-badge"
import type { MetricCatalogSummary } from "./metric-detail"
import { getMetricAttributeKeysResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { normalizeTimestampInput } from "@/lib/timezone-format"

function formatCount(value: number): string {
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
	return String(value)
}

function formatSeen(value: string): string {
	const date = new Date(normalizeTimestampInput(value))
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

interface MetricMetadataPanelProps {
	summary: MetricCatalogSummary
	startTime: string
	endTime: string
}

export function MetricMetadataPanel({ summary, startTime, endTime }: MetricMetadataPanelProps) {
	const keysResult = useAtomValue(
		getMetricAttributeKeysResultAtom({
			data: {
				startTime,
				endTime,
				metricName: summary.metricName,
				metricType: summary.metricType,
			},
		}),
	)

	return (
		<div className="flex flex-col gap-4 rounded-md border bg-card p-3">
			<div className="space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<MetricTypeBadge type={summary.metricType} />
					{summary.unit && (
						<Badge variant="outline" className="font-mono text-[10px]">
							{summary.unit}
						</Badge>
					)}
					{summary.metricType === "sum" && (
						<Badge variant="outline" className="text-[10px]">
							{summary.isMonotonic ? "monotonic" : "non-monotonic"}
						</Badge>
					)}
				</div>
				{summary.description && (
					<p className="text-xs text-muted-foreground">{summary.description}</p>
				)}
			</div>

			<dl className="space-y-2 text-xs">
				<div className="flex items-center justify-between gap-2">
					<dt className="text-muted-foreground">Datapoints in range</dt>
					<dd className="font-mono">{formatCount(summary.dataPointCount)}</dd>
				</div>
				<div className="flex items-center justify-between gap-2">
					<dt className="text-muted-foreground">First seen</dt>
					<dd className="font-mono">{formatSeen(summary.firstSeen)}</dd>
				</div>
				<div className="flex items-center justify-between gap-2">
					<dt className="text-muted-foreground">Last seen</dt>
					<dd className="font-mono">{formatSeen(summary.lastSeen)}</dd>
				</div>
			</dl>

			{summary.services.length > 0 && (
				<div className="space-y-1.5">
					<p className="text-xs text-muted-foreground">
						Emitted by {summary.services.length} service
						{summary.services.length !== 1 ? "s" : ""}
					</p>
					<div className="flex flex-wrap gap-1.5">
						{summary.services.map((service) => (
							<Badge key={service} variant="outline" className="font-mono text-[10px]">
								{service}
							</Badge>
						))}
					</div>
				</div>
			)}

			<div className="space-y-1.5">
				<p className="text-xs text-muted-foreground">Attributes</p>
				{Result.builder(keysResult)
					.onInitial(() => <Skeleton className="h-12 w-full" />)
					.onError(() => (
						<p className="text-xs text-muted-foreground">Failed to load attribute keys.</p>
					))
					.onSuccess((response) =>
						response.data.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								This metric has no datapoint attributes.
							</p>
						) : (
							<ul className="space-y-1">
								{response.data.map((row) => (
									<li
										key={row.attributeKey}
										className="flex items-center justify-between gap-2 text-xs"
									>
										<span className="truncate font-mono">{row.attributeKey}</span>
										<span className="shrink-0 font-mono text-muted-foreground">
											{formatCount(row.usageCount)}
										</span>
									</li>
								))}
							</ul>
						),
					)
					.render()}
			</div>
		</div>
	)
}
