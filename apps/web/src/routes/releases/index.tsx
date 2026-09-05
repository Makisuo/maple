import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { warmAtoms } from "@effect-router/core"
import { Schema } from "effect"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { ActiveFilterChips } from "@maple/ui/components/filters/active-filter-chips"
import { formatNumber } from "@maple/ui/lib/format"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { Result, useAtomRefresh } from "@/lib/effect-atom"
import { resolveEffectiveTimeRange, useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { getReleasesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { GetReleasesInput } from "@/api/warehouse/releases"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { LONG_RANGE_PRESET_OPTIONS } from "@/lib/time-utils"
import { ReleasesFilterSidebar } from "@/components/releases/releases-filter-sidebar"
import { ReleasesTimeline } from "@/components/releases/releases-timeline"
import { ReleasesTable } from "@/components/releases/releases-table"
import {
	RELEASE_HEALTH_ORDER,
	deriveReleaseImpacts,
	groupReleases,
	type ReleaseHealth,
} from "@/components/releases/release-model"
import { RELEASE_HEALTH_LABEL } from "@/components/releases/release-health"

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60
const DEFAULT_PRESET = "7d"

const releasesSearchSchema = Schema.Struct({
	environments: OptionalStringArrayParam,
	excludedEnvironments: OptionalStringArrayParam,
	services: OptionalStringArrayParam,
	// Render-only: the health band is derived client-side from the same rows,
	// so it never reaches the atom input.
	impact: Schema.optional(Schema.Literals(RELEASE_HEALTH_ORDER)),
	...TimeRangeSearchFields,
})

export type ReleasesSearchParams = Schema.Schema.Type<typeof releasesSearchSchema>

/**
 * The releases atom's input, from search alone. Exported so the loader, the
 * sidebar and the page cannot drift onto different keys — a mismatch does not
 * fail, it fetches twice.
 */
export function releasesQueryInput(search: ReleasesSearchParams): GetReleasesInput {
	const { startTime, endTime } = resolveEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	return {
		startTime,
		endTime,
		environments: search.environments,
		excludedEnvironments: search.excludedEnvironments,
		services: search.services,
	}
}

export const Route = createFileRoute("/releases/")({
	component: ReleasesPage,
	validateSearch: Schema.toStandardSchemaV1(releasesSearchSchema),
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) => {
		warmAtoms(context.effectRegistry, [getReleasesResultAtom({ data: releasesQueryInput(deps) })])
	},
})

function ReleasesPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev: Record<string, unknown>) => applyTimeRangeSearch(prev, range),
		})
	}

	const chips = [
		...(search.excludedEnvironments?.length
			? [
					{
						id: "excludedEnvironments",
						label: "Environment",
						values: search.excludedEnvironments,
						negated: true,
					},
				]
			: []),
		...(search.environments?.length
			? [{ id: "environments", label: "Environment", values: search.environments, negated: false }]
			: []),
		...(search.services?.length
			? [{ id: "services", label: "Service", values: search.services, negated: false }]
			: []),
		...(search.impact !== undefined
			? [
					{
						id: "impact",
						label: "Health",
						values: [RELEASE_HEALTH_LABEL[search.impact]],
						negated: false,
					},
				]
			: []),
	].map((chip) => ({
		...chip,
		onRemove: () => navigate({ search: (prev) => ({ ...prev, [chip.id]: undefined }) }),
	}))

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? DEFAULT_PRESET}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[{ label: "Releases" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Filters>
						<ReleasesFilterSidebar />
					</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								title="Releases"
								description="What shipped, per service, and whether it changed anything."
							>
								<TimeRangeHeaderControls
									startTime={search.startTime ?? effectiveStartTime}
									endTime={search.endTime ?? effectiveEndTime}
									presetValue={
										search.timePreset ?? (search.startTime ? undefined : DEFAULT_PRESET)
									}
									presets={LONG_RANGE_PRESET_OPTIONS}
									maxRangeSeconds={ONE_YEAR_SECONDS}
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<ActiveFilterChips chips={chips} />
							<ReleasesContent search={search} />
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}

function ReleasesSkeleton() {
	return (
		<div className="flex flex-col gap-3">
			<Skeleton className="h-4 w-64" />
			<Skeleton className="h-52 w-full rounded-md" />
			<Skeleton className="h-96 w-full rounded-md" />
		</div>
	)
}

function ReleasesContent({ search }: { search: ReleasesSearchParams }) {
	const atom = getReleasesResultAtom({ data: releasesQueryInput(search) })
	const result = useRefreshableAtomValue(atom)
	const refresh = useAtomRefresh(atom)

	const derived = useMemo(() => {
		if (!Result.isSuccess(result)) return undefined
		const impacts = deriveReleaseImpacts(result.value.releases, result.value.timeline)
		const groups = groupReleases(impacts)
		return { impacts, groups, response: result.value }
	}, [result])

	if (Result.isFailure(result)) {
		return (
			<QueryErrorState error={result.cause} titleOverride="Failed to load releases" onRetry={refresh} />
		)
	}
	if (derived === undefined) return <ReleasesSkeleton />

	const { impacts, groups, response } = derived
	const health: ReleaseHealth | undefined = search.impact
	const visibleGroups = health === undefined ? groups : groups.filter((group) => group.health === health)
	const visibleImpacts =
		health === undefined ? impacts : impacts.filter((impact) => impact.health === health)
	const services = new Set(impacts.map((impact) => impact.serviceName)).size
	const windowDays = Math.max(
		1 / 24,
		(Date.parse(response.endTime) - Date.parse(response.startTime)) / 86_400_000,
	)
	const flagged = groups.filter((group) => group.health === "regressed").length
	const timeSearch = pickTimeRangeSearch(search)
	const waiting = Result.isSuccess(result) && result.waiting

	if (groups.length === 0) {
		return (
			<div className="flex flex-col items-center gap-1 rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
				<span>No releases detected in this window.</span>
				<span className="text-xs text-muted-foreground/70">
					Release tracking needs spans to carry the{" "}
					<code className="rounded bg-muted px-1 py-px font-mono text-[11px]">
						vcs.ref.head.revision
					</code>{" "}
					resource attribute.
				</span>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-0.5 text-xs text-muted-foreground">
				<span>
					<span className="font-medium tabular-nums text-foreground">
						{formatNumber(groups.length)}
					</span>{" "}
					{groups.length === 1 ? "release" : "releases"}
				</span>
				<span>
					<span className="font-medium tabular-nums text-foreground">{formatNumber(services)}</span>{" "}
					{services === 1 ? "service" : "services"}
				</span>
				<span>
					<span className="font-medium tabular-nums text-foreground">
						{(groups.length / windowDays).toLocaleString(undefined, { maximumFractionDigits: 1 })}
					</span>{" "}
					per day
				</span>
				{flagged > 0 ? (
					<span>
						<span className="font-medium tabular-nums text-severity-error">
							{formatNumber(flagged)}
						</span>{" "}
						{flagged === 1 ? "release" : "releases"} with errors up
					</span>
				) : null}
				{response.truncated ? (
					<span className="text-muted-foreground/70">
						Showing the newest {formatNumber(response.releases.length)} rows
					</span>
				) : null}
			</div>
			<ReleasesTimeline
				impacts={visibleImpacts}
				startTime={response.startTime}
				endTime={response.endTime}
				timeSearch={timeSearch}
				environments={search.environments}
			/>
			{visibleGroups.length === 0 ? (
				<div className="rounded-md border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
					No releases match the health filter.
				</div>
			) : (
				<ReleasesTable
					groups={visibleGroups}
					timeSearch={timeSearch}
					environments={search.environments}
					waiting={waiting}
				/>
			)}
		</div>
	)
}
