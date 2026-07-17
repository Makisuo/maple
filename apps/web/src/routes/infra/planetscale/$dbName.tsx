import { useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"

import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { PageHero, HeroChip } from "@/components/infra/primitives/page-hero"
import { PlanetScaleBranchTable } from "@/components/infra/planetscale/planetscale-branch-table"
import { PlanetScaleChart } from "@/components/infra/planetscale/planetscale-chart"
import { PlanetScaleTopQueries } from "@/components/infra/planetscale/planetscale-top-queries"
import { chartBucketSeconds } from "@/components/infra/cloudflare/constants"
import {
	getPlanetScaleBranchStatsResultAtom,
	planetscaleInfraTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const planetscaleDbSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/infra/planetscale/$dbName")({
	component: PlanetScaleDatabasePage,
	validateSearch: Schema.toStandardSchemaV1(planetscaleDbSearchSchema),
})

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
						description="Branch-level health, live from PlanetScale."
						meta={
							database ? (
								<>
									<HeroChip>
										{database.kind === "postgresql" ? "Postgres" : "MySQL / Vitess"}
									</HeroChip>
									{database.region ? <HeroChip>{database.region}</HeroChip> : null}
									{database.plan ? <HeroChip>{database.plan}</HeroChip> : null}
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

	// Query-insights branch switcher: ready branches only, production first.
	// undefined = let the API resolve the production branch.
	const [insightsBranch, setInsightsBranch] = useState<string | undefined>(undefined)
	const insightsBranches = useMemo(
		() =>
			[...branchInfoByName.entries()]
				.filter(([, info]) => info.ready)
				.sort(([, a], [, b]) => Number(b.production) - Number(a.production))
				.map(([name]) => name),
		[branchInfoByName],
	)

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
					<PlanetScaleBranchTable
						branches={branchStats}
						branchInfoByName={branchInfoByName}
						waiting={Boolean(branchStatsResult.waiting)}
					/>
				</div>
			) : null}

			<div className="space-y-2">
				<div className="flex items-center justify-between gap-3">
					<h2 className="text-sm font-medium text-foreground">
						Top Queries (PlanetScale Insights)
					</h2>
					{insightsBranches.length > 1 ? (
						<Select
							items={Object.fromEntries(insightsBranches.map((name) => [name, name]))}
							value={insightsBranch ?? insightsBranches[0] ?? null}
							onValueChange={(value: string | null) =>
								setInsightsBranch(value ?? undefined)
							}
						>
							<SelectTrigger size="sm" className="w-44 font-mono text-xs">
								<SelectValue placeholder="Branch" />
							</SelectTrigger>
							<SelectContent>
								{insightsBranches.map((name) => (
									<SelectItem key={name} value={name}>
										{name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : null}
				</div>
				<PlanetScaleTopQueries
					database={database}
					branch={insightsBranch}
					startTime={startTime}
					endTime={endTime}
					limit={12}
				/>
			</div>
		</div>
	)
}
