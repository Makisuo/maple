import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { PlanetScaleIcon } from "@/components/icons"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/infra/primitives/stat-rail"
import {
	PlanetScaleDatabaseTable,
	PlanetScaleDatabaseTableLoading,
} from "@/components/infra/planetscale/planetscale-database-table"
import { PlanetScaleNotConnected } from "@/components/infra/planetscale/planetscale-not-connected"
import {
	METRICS_PAUSED_MESSAGE,
	METRICS_PAUSED_SHORT,
	PlanetScaleInventoryNotice,
	PlanetScaleMetricsNotice,
	PlanetScaleRevokedNotice,
	inventoryIsStale,
} from "@/components/infra/planetscale/planetscale-absence"
import {
	formatLag,
	formatStoragePercent,
	lagTone,
	utilizationTone,
} from "@/components/infra/planetscale/metrics"
import { PlanetScaleSetupState } from "@/components/infra/planetscale/planetscale-setup-state"
import {
	derivePlanetScaleSetup,
	metricsNeverCollected,
	type SetupStep,
} from "@/components/integrations/planetscale-setup-steps"
import { getServiceMapPlanetScaleResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { formatNumber } from "@maple/ui/lib/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const planetscaleSearchSchema = Schema.Struct({
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/infra/planetscale/")({
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
		retainedQueryV2("planetscaleIntegration", "status", {
			reactivityKeys: ["planetscaleIntegration"],
		}),
	)

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[{ label: "Infrastructure", href: "/infra" }, { label: "PlanetScale" }]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header>
								<TimeRangeHeaderControls
									startTime={search.startTime ?? startTime}
									endTime={search.endTime ?? endTime}
									presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-6">
								<PageHero
									title="PlanetScale"
									description="Database health from your PlanetScale organization — connections, CPU, memory, storage, and replication lag for every branch."
								/>
								{Result.builder(statusResult)
									.onInitial(() => (
										<div className="space-y-4">
											<StatRailLoading />
											<PlanetScaleDatabaseTableLoading />
										</div>
									))
									.onError((err) => <QueryErrorState error={err} />)
									.onSuccess((status) => {
										if (!status.connected) return <PlanetScaleNotConnected />
										return (
											<PlanetScaleData
												startTime={startTime}
												endTime={endTime}
												metricsPaused={status.metrics_auth === "missing"}
												neverCollected={metricsNeverCollected(status)}
												setupSteps={derivePlanetScaleSetup(status, Date.now()).steps}
												revoked={status.revoked_at !== null}
												lastInventoryError={status.last_inventory_error}
											/>
										)
									})
									.render()}
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}

function PlanetScaleData({
	startTime,
	endTime,
	metricsPaused,
	neverCollected,
	setupSteps,
	revoked,
	lastInventoryError,
}: {
	startTime: string
	endTime: string
	metricsPaused: boolean
	/** No scrape has ever landed — the page leads with setup instead of dashes. */
	neverCollected: boolean
	setupSteps: ReadonlyArray<SetupStep>
	revoked: boolean
	lastInventoryError: string | null
}) {
	const inventoryResult = useAtomValue(
		retainedQueryV2("planetscaleIntegration", "databases", {
			reactivityKeys: ["planetscaleIntegration"],
		}),
	)
	// Retained so changing the time range dims the numbers instead of replacing
	// the whole page with skeletons.
	const statsResult = useRefreshableAtomValue(
		getServiceMapPlanetScaleResultAtom({ data: { startTime, endTime } }),
	)

	const stats = Result.builder(statsResult)
		.onSuccess((r) => r.databases)
		.orElse(() => NO_STATS)
	const statsByName = useMemo(() => new Map(stats.map((row) => [row.database.toLowerCase(), row])), [stats])

	const totals = useMemo(() => {
		let connections = 0
		let lagMax = 0
		let storageMax: number | null = null
		let storageOwner: string | null = null
		let lagOwner: string | null = null
		for (const row of stats) {
			connections += row.connectionsAvg
			if (row.replicaLagMaxSeconds > lagMax) {
				lagMax = row.replicaLagMaxSeconds
				lagOwner = row.database
			}
			if (
				row.storageUsedPercent !== null &&
				(storageMax === null || row.storageUsedPercent > storageMax)
			) {
				storageMax = row.storageUsedPercent
				storageOwner = row.database
			}
		}
		return { connections, lagMax, lagOwner, storageMax, storageOwner }
	}, [stats])

	return Result.builder(inventoryResult)
		.onInitial(() => (
			<div className="space-y-4">
				<StatRailLoading />
				<PlanetScaleDatabaseTableLoading />
			</div>
		))
		.onError((err) => <QueryErrorState error={err} />)
		.onSuccess((inventory) => {
			const branchTotal = inventory.databases.reduce((sum, db) => sum + db.branches.length, 0)
			const showInventoryNotice =
				lastInventoryError !== null || inventoryIsStale(inventory.last_inventory_at, Date.now())
			return (
				<div className="space-y-6">
					{revoked ? <PlanetScaleRevokedNotice /> : null}
					{/* Setup replaces the notice entirely while nothing has ever been
					    collected — one screen saying one thing, not a warning stacked
					    on top of a page pretending to work. */}
					{metricsPaused && !neverCollected ? <PlanetScaleMetricsNotice /> : null}
					{showInventoryNotice ? (
						<PlanetScaleInventoryNotice
							lastInventoryAt={inventory.last_inventory_at}
							lastInventoryError={lastInventoryError}
						/>
					) : null}
					{Result.isFailure(statsResult) ? (
						<QueryErrorState
							error={statsResult.cause}
							className="flex flex-col gap-1 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs"
						/>
					) : null}
					{neverCollected ? <PlanetScaleSetupState steps={setupSteps} /> : null}
					{/* Inventory counts have no time series, so no sparkline slot to reserve. */}
					<StatRail>
						<StatRailItem
							compact
							eyebrow="Databases"
							value={String(inventory.databases.length)}
						/>
						<StatRailItem compact eyebrow="Branches" value={String(branchTotal)} />
						{neverCollected ? null : (
							<>
								<StatRailItem
									compact
									eyebrow="Worst storage"
									value={
										totals.storageMax === null
											? "—"
											: formatStoragePercent(totals.storageMax)
									}
									tone={
										totals.storageMax === null
											? "neutral"
											: utilizationTone(totals.storageMax)
									}
									subline={
										metricsPaused
											? METRICS_PAUSED_SHORT
											: totals.storageOwner !== null
												? totals.storageOwner
												: undefined
									}
								/>
								<StatRailItem
									compact
									eyebrow="Worst replica lag"
									value={
										metricsPaused && stats.length === 0 ? "—" : formatLag(totals.lagMax)
									}
									tone={lagTone(totals.lagMax)}
									subline={
										metricsPaused
											? METRICS_PAUSED_SHORT
											: totals.lagOwner !== null && totals.lagMax > 0
												? totals.lagOwner
												: `${formatNumber(totals.connections)} connections`
									}
								/>
							</>
						)}
					</StatRail>
					{inventory.databases.length === 0 ? (
						<Empty className="py-16">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<PlanetScaleIcon size={16} />
								</EmptyMedia>
								<EmptyTitle>No databases discovered yet</EmptyTitle>
								<EmptyDescription>
									Maple refreshes the database and branch list within a few minutes of
									connecting. If this persists, check that the connection still has the
									read_databases permission.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<PlanetScaleDatabaseTable
							databases={inventory.databases}
							statsByName={statsByName}
							waiting={Boolean(statsResult.waiting)}
							metricsPaused={neverCollected}
							emptyMessage={
								metricsPaused ? METRICS_PAUSED_MESSAGE : "No databases in the inventory."
							}
						/>
					)}
				</div>
			)
		})
		.render()
}

/** Stable empty fallback — a fresh `[]` per render would bust every downstream memo. */
const NO_STATS: ReadonlyArray<never> = []
