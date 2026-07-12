import { useMemo } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"

import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { PageHero, HeroChip } from "@/components/infra/primitives/page-hero"
import { PlanetScaleChart } from "@/components/infra/planetscale/planetscale-chart"
import { PlanetScaleTopQueries } from "@/components/infra/planetscale/planetscale-top-queries"
import { chartBucketSeconds } from "@/components/infra/cloudflare/constants"
import {
	getPlanetScaleBranchStatsResultAtom,
	planetscaleInfraTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatNumber } from "@/lib/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const planetscaleDbSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/infra/planetscale/$dbName"))({
	component: PlanetScaleDatabasePage,
	validateSearch: Schema.toStandardSchemaV1(planetscaleDbSearchSchema),
})

const formatLag = (seconds: number) =>
	seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds * 1000)}ms`

function PlanetScaleDatabasePage() {
	const { dbName } = Route.useParams()
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

	const inventoryResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "planetscaleDatabases", {
			reactivityKeys: ["planetscaleIntegrationStatus"],
		}),
	)
	const database = Result.builder(inventoryResult)
		.onSuccess((inventory) => inventory.databases.find((db) => db.name === dbName) ?? null)
		.orElse(() => null)

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout
				breadcrumbs={[
					{ label: "Infrastructure", href: "/infra" },
					{ label: "PlanetScale", href: "/infra/planetscale" },
					{ label: dbName },
				]}
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
						title={dbName}
						description="Branch-level health scraped from PlanetScale's metrics endpoints."
						meta={
							database ? (
								<>
									<HeroChip>
										{database.kind === "postgresql" ? "Postgres" : "MySQL / Vitess"}
									</HeroChip>
									{database.region ? <HeroChip>{database.region}</HeroChip> : null}
									<HeroChip>
										{database.branches.length} branch
										{database.branches.length === 1 ? "" : "es"}
									</HeroChip>
								</>
							) : undefined
						}
						actions={
							<Link
								to="/infra/planetscale"
								className="text-xs text-muted-foreground hover:text-foreground"
							>
								All databases
							</Link>
						}
					/>
					<PlanetScaleDatabaseData database={dbName} startTime={startTime} endTime={endTime} />
				</div>
			</DashboardLayout>
		</PageRefreshProvider>
	)
}

function PlanetScaleDatabaseData({
	database,
	startTime,
	endTime,
}: {
	database: string
	startTime: string
	endTime: string
}) {
	const bucketSeconds = chartBucketSeconds(startTime, endTime)
	const timeseriesResult = useRefreshableAtomValue(
		planetscaleInfraTimeseriesResultAtom({ data: { database, startTime, endTime, bucketSeconds } }),
	)
	const branchStatsResult = useRefreshableAtomValue(
		getPlanetScaleBranchStatsResultAtom({ data: { database, startTime, endTime } }),
	)
	const inventoryResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "planetscaleDatabases", {
			reactivityKeys: ["planetscaleIntegrationStatus"],
		}),
	)
	const branchInfoByName = useMemo(() => {
		const map = new Map<string, { production: boolean; ready: boolean }>()
		if (Result.isSuccess(inventoryResult)) {
			const db = inventoryResult.value.databases.find((entry) => entry.name === database)
			for (const branch of db?.branches ?? []) {
				map.set(branch.name, { production: branch.production, ready: branch.ready })
			}
		}
		return map
	}, [inventoryResult, database])

	const buckets = Result.builder(timeseriesResult)
		.onSuccess((r) => r.buckets)
		.orElse(() => [])
	const waiting = Boolean(timeseriesResult.waiting)
	const branchStats = Result.builder(branchStatsResult)
		.onSuccess((r) => r.branches)
		.orElse(() => [])

	if (Result.isFailure(timeseriesResult)) {
		return <QueryErrorState error={timeseriesResult.cause} />
	}
	if (Result.isInitial(timeseriesResult)) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-52 w-full" />
				<Skeleton className="h-52 w-full" />
			</div>
		)
	}

	return (
		<div className="space-y-6">
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				<PlanetScaleChart buckets={buckets} metric="connectionsAvg" waiting={waiting} syncId="ps-db" />
				<PlanetScaleChart buckets={buckets} metric="cpuMaxPercent" waiting={waiting} syncId="ps-db" />
				<PlanetScaleChart buckets={buckets} metric="memMaxPercent" waiting={waiting} syncId="ps-db" />
				<PlanetScaleChart
					buckets={buckets}
					metric="replicaLagMaxSeconds"
					waiting={waiting}
					syncId="ps-db"
				/>
			</div>

			{Result.isFailure(branchStatsResult) ? (
				<div className="space-y-2">
					<h2 className="text-sm font-medium text-foreground">Branches</h2>
					<QueryErrorState error={branchStatsResult.cause} />
				</div>
			) : branchStats.length > 0 ? (
				<div className="space-y-2">
					<h2 className="text-sm font-medium text-foreground">Branches</h2>
					<div className="overflow-hidden rounded-lg border border-border/60">
						<div className="grid grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] gap-2 border-b border-border/60 bg-muted/40 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							<span>Branch</span>
							<span className="text-right">Connections</span>
							<span className="text-right">CPU (max)</span>
							<span className="text-right">Memory (max)</span>
							<span className="text-right">Replica lag</span>
						</div>
						{branchStats.map((row) => {
							const info = branchInfoByName.get(row.branch)
							return (
								<div
									key={row.branch}
									className="grid grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] items-center gap-2 border-b border-border/40 px-3 py-2.5 text-xs last:border-b-0"
								>
									<span className="flex min-w-0 items-center gap-2">
										<span className="truncate font-mono text-foreground">{row.branch}</span>
										{info?.production ? (
											<Badge variant="outline" className="shrink-0">
												production
											</Badge>
										) : null}
									</span>
									<span className="text-right font-mono tabular-nums">
										{formatNumber(row.connectionsAvg)}
									</span>
									<span
										className={cn(
											"text-right font-mono tabular-nums",
											row.cpuMaxPercent > 80
												? "text-severity-error"
												: row.cpuMaxPercent > 60
													? "text-severity-warn"
													: undefined,
										)}
									>
										{row.cpuMaxPercent.toFixed(0)}%
									</span>
									<span className="text-right font-mono tabular-nums">
										{row.memMaxPercent.toFixed(0)}%
									</span>
									<span
										className={cn(
											"text-right font-mono tabular-nums",
											row.replicaLagMaxSeconds > 10
												? "text-severity-error"
												: row.replicaLagMaxSeconds > 1
													? "text-severity-warn"
													: undefined,
										)}
									>
										{formatLag(row.replicaLagMaxSeconds)}
									</span>
								</div>
							)
						})}
					</div>
				</div>
			) : null}

			<div className="space-y-2">
				<h2 className="text-sm font-medium text-foreground">Top Queries (PlanetScale Insights)</h2>
				<PlanetScaleTopQueries
					database={database}
					startTime={startTime}
					endTime={endTime}
					limit={12}
				/>
			</div>
		</div>
	)
}
