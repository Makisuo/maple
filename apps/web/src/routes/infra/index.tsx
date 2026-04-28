import { useMemo, useState } from "react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { useInfraEnabled } from "@/hooks/use-infra-enabled"

import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Input } from "@maple/ui/components/ui/input"
import { cn } from "@maple/ui/lib/utils"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MagnifierIcon, PlusIcon, ServerIcon } from "@/components/icons"
import { FleetGrid } from "@/components/infra/fleet-grid"
import { HostTable, HostTableLoading, type HostRow } from "@/components/infra/host-table"
import { HostSummaryCards, HostSummaryCardsLoading } from "@/components/infra/host-summary-cards"
import { InstallHostModal } from "@/components/infra/install-modal"
import { deriveHostStatus, type HostStatus } from "@/components/infra/format"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { listHostsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

export const Route = createFileRoute("/infra/")({
	component: InfraPage,
})

const FLEET_GRID_THRESHOLD = 4

type StatusFilter = "all" | HostStatus

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "active", label: "Active" },
	{ value: "idle", label: "Idle" },
	{ value: "down", label: "Down" },
]

function InfraPage() {
	const infraEnabled = useInfraEnabled()
	if (!infraEnabled) return <Navigate to="/" replace />
	return <InfraPageContent />
}

function InfraPageContent() {
	const [installOpen, setInstallOpen] = useState(false)
	const [search, setSearch] = useState("")
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "12h")

	const hostsResult = useAtomValue(
		listHostsResultAtom({
			data: {
				startTime,
				endTime,
				search: search.trim() || undefined,
			},
		}),
	)

	const heroActions = (
		<Button size="sm" onClick={() => setInstallOpen(true)}>
			<PlusIcon size={14} />
			Add host
		</Button>
	)

	return (
		<DashboardLayout breadcrumbs={[{ label: "Infrastructure" }]}>
			<div className="space-y-6">
				<PageHero
					title="Infrastructure"
					description="Hosts, containers, and Kubernetes nodes reporting to Maple."
					actions={heroActions}
				/>

				{Result.builder(hostsResult)
					.onInitial(() => (
						<div className="space-y-6">
							<HostSummaryCardsLoading />
							<HostTableLoading />
						</div>
					))
					.onError((err) => (
						<div className="rounded-md border border-destructive/50 bg-destructive/10 p-8">
							<p className="font-medium text-destructive">Failed to load hosts</p>
							<pre className="mt-2 text-xs text-destructive/80 whitespace-pre-wrap">
								{err.message}
							</pre>
						</div>
					))
					.onSuccess((response, result) => {
						const hosts = response.data as ReadonlyArray<HostRow>

						if (hosts.length === 0 && !search.trim()) {
							return (
								<Empty className="py-16">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<ServerIcon size={16} />
										</EmptyMedia>
										<EmptyTitle>No hosts reporting yet</EmptyTitle>
										<EmptyDescription>
											Install the Maple infrastructure agent on a host, container, or
											Kubernetes cluster to start collecting CPU, memory, disk, and
											network metrics.
										</EmptyDescription>
									</EmptyHeader>
									<Button onClick={() => setInstallOpen(true)}>
										<PlusIcon size={14} />
										Add host
									</Button>
								</Empty>
							)
						}

						return (
							<FleetView
								hosts={hosts}
								waiting={Boolean(result.waiting)}
								startTime={startTime}
								endTime={endTime}
								search={search}
								onSearchChange={setSearch}
								statusFilter={statusFilter}
								onStatusFilterChange={setStatusFilter}
							/>
						)
					})
					.render()}
			</div>

			<InstallHostModal open={installOpen} onOpenChange={setInstallOpen} />
		</DashboardLayout>
	)
}

interface FleetViewProps {
	hosts: ReadonlyArray<HostRow>
	waiting: boolean
	startTime: string
	endTime: string
	search: string
	onSearchChange: (v: string) => void
	statusFilter: StatusFilter
	onStatusFilterChange: (v: StatusFilter) => void
}

function FleetView({
	hosts,
	waiting,
	startTime,
	endTime,
	search,
	onSearchChange,
	statusFilter,
	onStatusFilterChange,
}: FleetViewProps) {
	const annotated = useMemo(
		() => hosts.map((h) => ({ host: h, status: deriveHostStatus(h.lastSeen) })),
		[hosts],
	)

	const counts = useMemo(() => {
		const c: Record<HostStatus, number> = { active: 0, idle: 0, down: 0 }
		for (const a of annotated) c[a.status]++
		return c
	}, [annotated])

	const filtered = useMemo(() => {
		if (statusFilter === "all") return hosts
		return annotated.filter((a) => a.status === statusFilter).map((a) => a.host)
	}, [hosts, annotated, statusFilter])

	const showFleetGrid = hosts.length >= FLEET_GRID_THRESHOLD

	return (
		<div className={cn("space-y-6 transition-opacity", waiting && "opacity-60")}>
			<HostSummaryCards hosts={hosts} startTime={startTime} endTime={endTime} />

			{showFleetGrid && <FleetGrid hosts={hosts} />}

			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="relative">
					<MagnifierIcon
						size={12}
						className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						placeholder="Search hosts…"
						value={search}
						onChange={(e) => onSearchChange(e.target.value)}
						className="h-8 w-64 pl-7 text-xs"
					/>
				</div>
				<div
					role="tablist"
					aria-label="Filter hosts by status"
					className="flex items-center gap-0.5 rounded-md border bg-background p-0.5"
				>
					{STATUS_FILTERS.map((opt) => {
						const count =
							opt.value === "all" ? hosts.length : (counts[opt.value as HostStatus] ?? 0)
						const active = statusFilter === opt.value
						return (
							<button
								key={opt.value}
								type="button"
								role="tab"
								aria-selected={active}
								onClick={() => onStatusFilterChange(opt.value)}
								className={cn(
									"inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11px] font-medium transition-colors",
									active
										? "bg-foreground text-background"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{opt.label}
								<span
									className={cn(
										"tabular-nums",
										active ? "text-background/70" : "text-foreground/40",
									)}
								>
									{count}
								</span>
							</button>
						)
					})}
				</div>
			</div>

			<HostTable hosts={filtered} waiting={waiting} />
		</div>
	)
}
