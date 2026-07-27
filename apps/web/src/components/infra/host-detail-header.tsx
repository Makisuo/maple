import { Skeleton } from "@maple/ui/components/ui/skeleton"

import type { HostDetailSummaryResponse } from "@maple/domain/http"

import { HostStatusBadge } from "./status-badge"
import { HeroChip, PageHero } from "./primitives/page-hero"
import { StatRail, StatRailItem, StatRailLoading } from "./primitives/stat-rail"
import { severityLevel } from "./format"
import { formatLoad, formatPercent } from "@maple/ui/format"
import { formatRelativeTime } from "@maple/ui/time-format"

interface HostDetailHeaderProps {
	summary: HostDetailSummaryResponse["data"]
	hostName: string
}

export function HostDetailHeader({ summary, hostName }: HostDetailHeaderProps) {
	if (!summary) {
		return (
			<PageHero
				title={<span className="font-mono">{hostName}</span>}
				description="No metrics have arrived in the selected time window."
			/>
		)
	}

	const meta = (
		<>
			{summary.osType && <HeroChip>os {summary.osType}</HeroChip>}
			{summary.hostArch && <HeroChip>arch {summary.hostArch}</HeroChip>}
			{summary.cloudProvider && <HeroChip>cloud {summary.cloudProvider}</HeroChip>}
			{summary.cloudRegion && <HeroChip>region {summary.cloudRegion}</HeroChip>}
			<span className="text-[11px] text-muted-foreground/80">
				last reported {formatRelativeTime(summary.lastSeen)}
			</span>
		</>
	)

	return (
		<div className="space-y-6">
			<PageHero
				title={<span className="font-mono">{summary.hostName}</span>}
				meta={meta}
				trailing={<HostStatusBadge lastSeen={summary.lastSeen} />}
			/>
			<StatRail>
				<StatRailItem
					eyebrow="CPU"
					value={formatPercent(summary.cpuPct)}
					tone={severityLevel(summary.cpuPct)}
					subline="warn ≥ 80%"
					compact
				/>
				<StatRailItem
					eyebrow="Memory"
					value={formatPercent(summary.memoryPct)}
					tone={severityLevel(summary.memoryPct)}
					subline="warn ≥ 80%"
					compact
				/>
				<StatRailItem
					eyebrow="Disk"
					value={formatPercent(summary.diskPct)}
					tone={severityLevel(summary.diskPct)}
					subline="warn ≥ 80%"
					compact
				/>
				<StatRailItem eyebrow="Load 15m" value={formatLoad(summary.load15)} compact />
			</StatRail>
		</div>
	)
}

export function HostDetailHeaderLoading() {
	return (
		<div className="space-y-6">
			<div>
				<Skeleton className="h-7 w-72" />
				<Skeleton className="mt-2 h-3 w-96" />
			</div>
			<StatRailLoading />
		</div>
	)
}
