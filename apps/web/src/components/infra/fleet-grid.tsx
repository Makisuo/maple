import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"

import { deriveHostStatus, severityLevel, type HostStatus } from "./format"
import { formatPercent } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import {
	HoneycombSection,
	type HoneycombCell,
	type HoneycombLegendItem,
	type HoneycombTone,
} from "./honeycomb"
import type { HostRow } from "./host-table"

interface FleetGridProps {
	hosts: ReadonlyArray<HostRow>
}

const SORT_OPTIONS = [
	{ value: "worst", label: "Worst" },
	{ value: "cpu", label: "CPU" },
	{ value: "memory", label: "Mem" },
	{ value: "disk", label: "Disk" },
	{ value: "name", label: "Name" },
] as const

type SortKey = (typeof SORT_OPTIONS)[number]["value"]

interface AnnotatedHost {
	host: HostRow
	worst: number
	status: HostStatus
	tone: HoneycombTone
}

function annotate(host: HostRow): AnnotatedHost {
	const status = deriveHostStatus(host.lastSeen)
	const worst = Math.max(host.cpuPct ?? 0, host.memoryPct ?? 0, host.diskPct ?? 0)
	const tone: HoneycombTone = status === "active" ? severityLevel(worst) : "stale"
	return { host, worst, status, tone }
}

function sortHosts(rows: ReadonlyArray<AnnotatedHost>, key: SortKey): AnnotatedHost[] {
	const copy = [...rows]
	switch (key) {
		case "worst":
			copy.sort((a, b) => b.worst - a.worst)
			break
		case "cpu":
			copy.sort((a, b) => (b.host.cpuPct ?? 0) - (a.host.cpuPct ?? 0))
			break
		case "memory":
			copy.sort((a, b) => (b.host.memoryPct ?? 0) - (a.host.memoryPct ?? 0))
			break
		case "disk":
			copy.sort((a, b) => (b.host.diskPct ?? 0) - (a.host.diskPct ?? 0))
			break
		case "name":
			copy.sort((a, b) => a.host.hostName.localeCompare(b.host.hostName))
			break
	}
	return copy
}

export function FleetGrid({ hosts }: FleetGridProps) {
	const [sortKey, setSortKey] = useState<SortKey>("worst")

	const annotated = useMemo(() => hosts.map(annotate), [hosts])
	const sorted = useMemo(() => sortHosts(annotated, sortKey), [annotated, sortKey])

	const cells = useMemo<HoneycombCell[]>(
		() =>
			sorted.map(({ host, status, tone, worst }) => ({
				key: host.hostName,
				glyph: host.hostName.charAt(0).toUpperCase() || "·",
				tone,
				link: (
					<Link
						to="/infra/$hostName"
						params={{ hostName: host.hostName }}
						aria-label={`${host.hostName} — ${status}, worst ${formatPercent(worst)}`}
					/>
				),
				tooltip: (
					<>
						<div className="font-mono font-medium">{host.hostName}</div>
						<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono tabular-nums">
							<span className="text-muted-foreground">CPU</span>
							<span>{formatPercent(host.cpuPct)}</span>
							<span className="text-muted-foreground">Memory</span>
							<span>{formatPercent(host.memoryPct)}</span>
							<span className="text-muted-foreground">Disk</span>
							<span>{formatPercent(host.diskPct)}</span>
						</div>
						<div className="border-t pt-1 text-[10px] text-muted-foreground">
							{status === "active" ? "Active" : status === "idle" ? "Idle" : "Down"} ·{" "}
							{formatRelativeTime(host.lastSeen)}
						</div>
					</>
				),
			})),
		[sorted],
	)

	const legend = useMemo<HoneycombLegendItem[]>(() => {
		const c: Record<HoneycombTone, number> = { ok: 0, warn: 0, crit: 0, stale: 0 } satisfies Record<
			HoneycombTone,
			number
		>
		for (const a of annotated) c[a.tone]++
		return [
			{ tone: "ok", label: "Healthy", count: c.ok },
			{ tone: "warn", label: "Elevated", count: c.warn },
			{ tone: "crit", label: "Saturated", count: c.crit },
			{ tone: "stale", label: "Stale", count: c.stale },
		]
	}, [annotated])

	const actions = (
		<div className="flex flex-wrap items-center gap-1">
			<span className="mr-1 text-[11px] text-muted-foreground">Sort</span>
			{SORT_OPTIONS.map((opt) => (
				<button
					key={opt.value}
					type="button"
					onClick={() => setSortKey(opt.value)}
					className={cn(
						"rounded px-2 py-0.5 text-[11px] transition-colors",
						sortKey === opt.value
							? "bg-muted text-foreground"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{opt.label}
				</button>
			))}
		</div>
	)

	return (
		<HoneycombSection
			label="Fleet"
			count={hosts.length}
			unit="host"
			cells={cells}
			legend={legend}
			footnote="cell = max(cpu, memory, disk)"
			actions={actions}
		/>
	)
}
