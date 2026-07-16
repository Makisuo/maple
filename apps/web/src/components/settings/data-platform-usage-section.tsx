import type { ReactNode } from "react"
import { formatCount } from "@/lib/format"
import { Result } from "@/lib/effect-atom"
import { ChartLineIcon, DatabaseIcon, FileIcon, GridSquareCirclePlusIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { getServiceUsageResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import type { ServiceUsageResponse } from "@/api/warehouse/service-usage"

// "Total in the DB": sum every retained usage row for the org. Fixed bounds
// (not a rolling window) keep the atom key stable and capture all stored data.
const ALL_TIME = { startTime: "2000-01-01 00:00:00", endTime: "2099-12-31 23:59:59" }

function formatNumber(num: number): string {
	if (num >= 1_000_000_000_000) return `${(num / 1_000_000_000_000).toFixed(2)}T`
	if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
	if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`
	return formatCount(num)
}

function formatBytes(bytes: number): string {
	if (bytes >= 1_000_000_000_000) return `${(bytes / 1_000_000_000_000).toFixed(2)} TB`
	if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`
	if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(2)} KB`
	return `${bytes} B`
}

type StatKey = "logs" | "traces" | "metrics" | "dataSize"

const STATS: ReadonlyArray<{
	key: StatKey
	label: string
	icon: typeof FileIcon
	badge: string
	format: (n: number) => string
}> = [
	{ key: "logs", label: "Logs", icon: FileIcon, badge: "bg-chart-2/10 text-chart-2", format: formatNumber },
	{
		key: "traces",
		label: "Traces",
		icon: GridSquareCirclePlusIcon,
		badge: "bg-chart-5/10 text-chart-5",
		format: formatNumber,
	},
	{
		key: "metrics",
		label: "Metrics",
		icon: ChartLineIcon,
		badge: "bg-chart-3/10 text-chart-3",
		format: formatNumber,
	},
	{
		key: "dataSize",
		label: "Storage",
		icon: DatabaseIcon,
		badge: "bg-chart-1/10 text-chart-1",
		format: formatBytes,
	},
]

function sumTotals(response: ServiceUsageResponse) {
	return response.data.reduce(
		(acc, service) => ({
			logs: acc.logs + service.totalLogs,
			traces: acc.traces + service.totalTraces,
			metrics: acc.metrics + service.totalMetrics,
			dataSize: acc.dataSize + service.dataSizeBytes,
		}),
		{ logs: 0, traces: 0, metrics: 0, dataSize: 0 },
	)
}

function StatTile({ stat, children }: { stat: (typeof STATS)[number]; children: ReactNode }) {
	const Icon = stat.icon
	return (
		<div className="group relative overflow-hidden rounded-xl border bg-card p-5 transition-colors hover:border-foreground/20">
			<Icon
				size={76}
				aria-hidden
				className="pointer-events-none absolute -right-3 -bottom-4 text-foreground/[0.035] transition-colors group-hover:text-foreground/[0.05]"
			/>
			<span className={cn("flex size-9 items-center justify-center rounded-lg", stat.badge)}>
				<Icon size={16} />
			</span>
			<div className="relative mt-4 min-h-[2rem]">{children}</div>
			<div className="relative mt-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{stat.label}
			</div>
		</div>
	)
}

export function DataPlatformUsageSection() {
	const result = useRefreshableAtomValue(getServiceUsageResultAtom({ data: ALL_TIME }))

	return (
		<section className="space-y-3">
			<div className="space-y-0.5">
				<h2 className="font-display text-sm font-medium text-foreground">Stored data</h2>
				<p className="text-muted-foreground text-xs">
					Everything currently held in the warehouse for this organization.
				</p>
			</div>

			<div className="grid grid-cols-2 gap-3">
				{Result.builder(result)
					.onSuccess((response) => {
						const totals = sumTotals(response)
						return STATS.map((stat) => (
							<StatTile key={stat.key} stat={stat}>
								<span className="font-mono text-[2rem] font-semibold leading-none tracking-tight tabular-nums text-foreground">
									{stat.format(totals[stat.key])}
								</span>
							</StatTile>
						))
					})
					.onError(() =>
						STATS.map((stat) => (
							<StatTile key={stat.key} stat={stat}>
								<span className="text-sm text-muted-foreground">—</span>
							</StatTile>
						)),
					)
					.orElse(() =>
						STATS.map((stat) => (
							<StatTile key={stat.key} stat={stat}>
								<Skeleton className="h-8 w-24" />
							</StatTile>
						)),
					)}
			</div>
		</section>
	)
}
