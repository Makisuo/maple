import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"

import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { StatRail, StatRailItem } from "@/components/infra/primitives/stat-rail"
import {
	PlanetScaleDatabaseTable,
	PlanetScaleDatabaseTableLoading,
} from "@/components/infra/planetscale/planetscale-database-table"
import { PlanetScaleNotConnected } from "@/components/infra/planetscale/planetscale-not-connected"
import { getServiceMapPlanetScaleResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatNumber, formatRelativeTime } from "@/lib/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const planetscaleSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/infra/planetscale/"))({
	component: PlanetScalePage,
	validateSearch: Schema.toStandardSchemaV1(planetscaleSearchSchema),
})

function PlanetScalePage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	// Integration-gated: the page is useful exactly when the org has the
	// PlanetScale integration connected.
	const statusResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "planetscaleStatus", {
			reactivityKeys: ["planetscaleIntegrationStatus"],
		}),
	)

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout
				breadcrumbs={[{ label: "Infrastructure", href: "/infra" }, { label: "PlanetScale" }]}
				headerActions={
					<TimeRangeHeaderControls
						startTime={search.startTime ?? startTime}
						endTime={search.endTime ?? endTime}
						presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
						onTimeChange={handleTimeChange}
					/>
				}
			>
				<div className="space-y-6">
					<PageHero
						title="PlanetScale"
						description="Database health from your PlanetScale organization — connections, CPU, memory, and replication lag for every branch."
					/>
					{Result.builder(statusResult)
						.onInitial(() => (
							<div className="space-y-4">
								<Skeleton className="h-28 w-full" />
								<Skeleton className="h-64 w-full" />
							</div>
						))
						.onError((err) => <QueryErrorState error={err} />)
						.onSuccess((status) => {
							if (!status.connected) return <PlanetScaleNotConnected />
							return (
								<PlanetScaleData
									startTime={startTime}
									endTime={endTime}
									lastInventoryError={status.lastInventoryError}
								/>
							)
						})
						.render()}
				</div>
			</DashboardLayout>
		</PageRefreshProvider>
	)
}

// Inventory refreshes every few minutes — older than this and the database
// list is likely out of date (poller stalled, token revoked).
const INVENTORY_STALE_MS = 15 * 60 * 1000

function PlanetScaleData({
	startTime,
	endTime,
	lastInventoryError,
}: {
	startTime: string
	endTime: string
	lastInventoryError: string | null
}) {
	const inventoryResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "planetscaleDatabases", {
			reactivityKeys: ["planetscaleIntegrationStatus"],
		}),
	)
	const statsResult = useRefreshableAtomValue(
		getServiceMapPlanetScaleResultAtom({ data: { startTime, endTime } }),
	)

	const stats = Result.builder(statsResult)
		.onSuccess((r) => r.databases)
		.orElse(() => [])
	const statsByName = useMemo(
		() => new Map(stats.map((row) => [row.database.toLowerCase(), row])),
		[stats],
	)

	const totals = useMemo(() => {
		let connections = 0
		let cpuMax = 0
		let lagMax = 0
		for (const row of stats) {
			connections += row.connectionsAvg
			cpuMax = Math.max(cpuMax, row.cpuMaxPercent)
			lagMax = Math.max(lagMax, row.replicaLagMaxSeconds)
		}
		return { connections, cpuMax, lagMax }
	}, [stats])

	return Result.builder(inventoryResult)
		.onInitial(() => (
			<div className="space-y-4">
				<Skeleton className="h-28 w-full" />
				<PlanetScaleDatabaseTableLoading />
			</div>
		))
		.onError((err) => <QueryErrorState error={err} />)
		.onSuccess((inventory) => {
			const branchTotal = inventory.databases.reduce((sum, db) => sum + db.branches.length, 0)
			const inventoryStale =
				inventory.lastInventoryAt !== null &&
				Date.now() - inventory.lastInventoryAt > INVENTORY_STALE_MS
			return (
				<div className="space-y-6">
					{lastInventoryError !== null || inventoryStale ? (
						<p className="text-xs text-severity-warn">
							{lastInventoryError !== null
								? "Inventory refresh failing — the database list may be out of date."
								: `Inventory last refreshed ${formatRelativeTime(
										new Date(inventory.lastInventoryAt ?? 0).toISOString(),
									)} — the database list may be out of date.`}
						</p>
					) : null}
					{Result.isFailure(statsResult) ? (
						<QueryErrorState
							error={statsResult.cause}
							className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs flex flex-col gap-1"
						/>
					) : null}
					<StatRail>
						<StatRailItem eyebrow="Databases" value={String(inventory.databases.length)} />
						<StatRailItem eyebrow="Branches" value={String(branchTotal)} />
						<StatRailItem eyebrow="Connections" value={formatNumber(totals.connections)} />
						<StatRailItem
							eyebrow="Worst replica lag"
							value={
								totals.lagMax >= 1
									? `${totals.lagMax.toFixed(1)}s`
									: `${Math.round(totals.lagMax * 1000)}ms`
							}
							tone={totals.lagMax > 10 ? "crit" : totals.lagMax > 1 ? "warn" : "neutral"}
						/>
					</StatRail>
					{inventory.databases.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No databases discovered yet — the inventory refreshes within a few minutes of
							connecting.
						</p>
					) : (
						<PlanetScaleDatabaseTable
							databases={inventory.databases}
							statsByName={statsByName}
							waiting={Boolean(statsResult.waiting)}
						/>
					)}
				</div>
			)
		})
		.render()
}
