import { Result, useAtomValue } from "@/lib/effect-atom"

import { fleetUtilizationTimeseriesResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"

import { StatRail, StatRailItem, StatRailLoading } from "./primitives/stat-rail"
import { deriveHostStatus, formatPercent, severityLevel } from "./format"
import type { HostRow } from "./host-table"

interface HostSummaryCardsProps {
	hosts: ReadonlyArray<HostRow>
	startTime: string
	endTime: string
	bucketSeconds?: number
}

export function HostSummaryCards({ hosts, startTime, endTime, bucketSeconds = 300 }: HostSummaryCardsProps) {
	const trendsResult = useAtomValue(
		fleetUtilizationTimeseriesResultAtom({
			data: { startTime, endTime, bucketSeconds },
		}),
	)

	const trends = Result.builder(trendsResult)
		.onSuccess((r) => r.data)
		.orElse(() => null)

	const total = hosts.length
	const active = hosts.filter((h) => deriveHostStatus(h.lastSeen) === "active").length
	const stale = total - active
	const avg = (pick: (h: HostRow) => number) => {
		if (hosts.length === 0) return 0
		const sum = hosts.reduce((acc, h) => acc + (Number.isFinite(pick(h)) ? pick(h) : 0), 0)
		return sum / hosts.length
	}
	const cpuAvg = avg((h) => h.cpuPct)
	const memoryAvg = avg((h) => h.memoryPct)
	const cpuOver80 = hosts.filter((h) => (h.cpuPct ?? 0) >= 0.8).length
	const memOver80 = hosts.filter((h) => (h.memoryPct ?? 0) >= 0.8).length

	const cpuSpark = trends?.map((t) => t.avgCpu) ?? []
	const memSpark = trends?.map((t) => t.avgMemory) ?? []
	const hostsSpark = trends?.map((t) => t.activeHosts) ?? []

	const healthyPct = total === 0 ? 0 : Math.round((active / Math.max(total, 1)) * 100)
	const healthyTone =
		stale === 0
			? ("ok" as const)
			: stale / Math.max(total, 1) >= 0.25
				? ("crit" as const)
				: ("warn" as const)

	return (
		<StatRail>
			<StatRailItem
				eyebrow="Hosts"
				value={String(total)}
				delta={`${active} ↑`}
				spark={hostsSpark}
				subline={
					stale > 0 ? (
						<>
							{active} active <span className="text-foreground/30">·</span> {stale}{" "}
							<span className="text-muted-foreground/70">idle/down</span>
						</>
					) : (
						<>{active} reporting</>
					)
				}
				delay={0}
			/>
			<StatRailItem
				eyebrow="Healthy"
				value={`${healthyPct}%`}
				tone={healthyTone}
				subline={
					stale === 0 ? (
						"All hosts reporting"
					) : (
						<>
							<span className="text-foreground/80">{stale}</span> not reporting
						</>
					)
				}
				delay={60}
			/>
			<StatRailItem
				eyebrow="Avg CPU"
				value={formatPercent(cpuAvg)}
				tone={severityLevel(cpuAvg)}
				spark={cpuSpark}
				subline={
					cpuOver80 > 0 ? (
						<>
							<span className="text-[var(--severity-warn)]">{cpuOver80}</span> host
							{cpuOver80 === 1 ? "" : "s"} over 80%
						</>
					) : (
						"No hosts above 80% threshold"
					)
				}
				delay={120}
			/>
			<StatRailItem
				eyebrow="Avg memory"
				value={formatPercent(memoryAvg)}
				tone={severityLevel(memoryAvg)}
				spark={memSpark}
				subline={
					memOver80 > 0 ? (
						<>
							<span className="text-[var(--severity-warn)]">{memOver80}</span> host
							{memOver80 === 1 ? "" : "s"} over 80%
						</>
					) : (
						"No hosts above 80% threshold"
					)
				}
				delay={180}
			/>
		</StatRail>
	)
}

export function HostSummaryCardsLoading() {
	return <StatRailLoading />
}
