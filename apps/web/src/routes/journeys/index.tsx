import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { BooleanFromStringParam, NumberFromStringParam } from "@/lib/search-params"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { journeyFacetsResultAtom, listJourneysResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import type { TimeRange } from "@/components/time-range-picker/types"

import { JourneysFilterSidebar } from "@/components/journeys/overview/journeys-filter-sidebar"
import { JourneysToolbar } from "@/components/journeys/overview/journeys-toolbar"
import { JourneysList, JourneysListSkeleton } from "@/components/journeys/overview/journeys-list"
import {
	JourneysEmptyFilters,
	JourneysEmptyRange,
	type ActiveJourneyFilter,
} from "@/components/journeys/overview/journeys-empty-states"
import {
	COST_OUTLIER_DOLLARS,
	DEFAULT_JOURNEY_SORT,
	hasActiveJourneyFilters,
	journeysFilterInputs,
	journeysSortInputs,
	type JourneySort,
} from "@/components/journeys/overview/journeys-filter-inputs"
import { JOURNEYS_PAGE_SIZE, useInfiniteJourneys } from "@/components/journeys/overview/use-infinite-journeys"
import { formatCost } from "@/components/journeys/overview/journeys-format"

const NumberParam = Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam]))

const journeysSearchSchema = Schema.Struct({
	status: Schema.optional(Schema.Literals(["ok", "error", "running"])),
	finishReason: Schema.optional(Schema.String),
	agent: Schema.optional(Schema.String),
	workflow: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	provider: Schema.optional(Schema.String),
	service: Schema.optional(Schema.String),
	hasTools: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	/** Substring over the title sample and the journey id. Written by both the
	 *  toolbar search and the sidebar's "Journey ID" field. */
	q: Schema.optional(Schema.String),
	// Duration bounds are whole seconds in the URL (human-friendly); mapped to ms
	// before the warehouse sees them. Everything else is in its natural unit.
	durationMin: NumberParam,
	durationMax: NumberParam,
	turnMin: NumberParam,
	turnMax: NumberParam,
	tokenMin: NumberParam,
	tokenMax: NumberParam,
	costMin: NumberParam,
	costMax: NumberParam,
	sort: Schema.optional(Schema.Literals(["startTime", "cost", "duration", "turns", "tokens"])),
	sortDirection: Schema.optional(Schema.Literals(["asc", "desc"])),
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/journeys/")({
	component: JourneysPage,
	validateSearch: Schema.toStandardSchemaV1(journeysSearchSchema),
	loaderDeps: ({ search }) => search,
	// Both queries are on the critical path and neither is cached server-side, so
	// starting them on `intent` preload beats waiting for the route chunk and the
	// first commit. Fire-and-forget: the component reads the same entries.
	loader: ({ context, deps }) => {
		const filterInputs = journeysFilterInputs(deps)
		context.effectRegistry.mount(
			listJourneysResultAtom({
				data: {
					...filterInputs,
					...journeysSortInputs(deps),
					limit: JOURNEYS_PAGE_SIZE,
					offset: 0,
				},
			}),
		)
		context.effectRegistry.mount(journeyFacetsResultAtom({ data: filterInputs }))
	},
})

/** "last 24 hours" / "selected range" — the noun the empty states put the count in. */
function rangeLabel(timePreset: string | undefined, hasCustomRange: boolean): string {
	if (hasCustomRange) return "selected range"
	const preset = timePreset ?? "24h"
	const match = /^(\d+)([mhdw])$/.exec(preset)
	if (!match) return "selected range"
	const amount = Number(match[1])
	const unit = { m: "minute", h: "hour", d: "day", w: "week" }[match[2]!]!
	return `last ${amount} ${unit}${amount === 1 ? "" : "s"}`
}

function JourneysPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const filterInputs = useMemo(
		() => journeysFilterInputs(search),
		[
			search.startTime,
			search.endTime,
			search.timePreset,
			search.status,
			search.finishReason,
			search.agent,
			search.workflow,
			search.model,
			search.provider,
			search.service,
			search.hasTools,
			search.q,
			search.durationMin,
			search.durationMax,
			search.turnMin,
			search.turnMax,
			search.tokenMin,
			search.tokenMax,
			search.costMin,
			search.costMax,
		],
	)
	const { startTime, endTime } = filterInputs
	const sortInputs = useMemo(() => journeysSortInputs(search), [search.sort, search.sortDirection])
	const listInputs = useMemo(() => ({ ...filterInputs, ...sortInputs }), [filterInputs, sortInputs])

	const { firstPageResult, allData, hasNextPage, isCapped, isFetchingNextPage, fetchNextPage } =
		useInfiniteJourneys(listInputs)
	const facetsResult = useAtomValue(journeyFacetsResultAtom({ data: filterInputs }))
	const facets = Result.isSuccess(facetsResult) ? facetsResult.value : undefined

	const journeys = allData
	const liveCount = journeys.filter((journey) => journey.status === "running").length
	// Both header figures describe what's loaded, not the whole window — the list
	// is capped, and a total the list can't show you is a number you can't act on.
	const spent = journeys.reduce((sum, journey) => sum + (journey.cost ?? 0), 0)
	const erroredCount = facets?.statuses.find((item) => item.name === "error")?.count ?? 0
	const truncatedCount = facets?.finishReasons.find((item) => item.name === "length")?.count ?? 0

	const setSearch = (patch: Record<string, unknown>) => {
		navigate({ search: (prev) => ({ ...prev, ...patch }) })
	}

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => applyTimeRangeSearch(prev, range),
		})
	}

	const activeSort: JourneySort = search.sort ?? DEFAULT_JOURNEY_SORT

	// Clicking a numeric column header sorts by it; clicking the active one flips
	// direction. The toolbar control and the headers are one setting.
	const handleColumnSort = (key: "cost" | "duration" | "turns" | "tokens") => {
		setSearch(
			activeSort === key
				? { sortDirection: search.sortDirection === "asc" ? "desc" : "asc" }
				: { sort: key, sortDirection: undefined },
		)
	}

	const filtersApplied = hasActiveJourneyFilters(search)

	const activeFilterChips: ReadonlyArray<ActiveJourneyFilter> = [
		chip(
			"status",
			search.status,
			(value) => value,
			() => setSearch({ status: undefined }),
		),
		chip(
			"finishReason",
			search.finishReason,
			(value) => value,
			() => setSearch({ finishReason: undefined }),
		),
		chip(
			"agent",
			search.agent,
			(value) => value,
			() => setSearch({ agent: undefined }),
		),
		chip(
			"workflow",
			search.workflow,
			(value) => value,
			() => setSearch({ workflow: undefined }),
		),
		chip(
			"model",
			search.model,
			(value) => value,
			() => setSearch({ model: undefined }),
		),
		chip(
			"provider",
			search.provider,
			(value) => value,
			() => setSearch({ provider: undefined }),
		),
		chip(
			"service",
			search.service,
			(value) => value,
			() => setSearch({ service: undefined }),
		),
		chip(
			"q",
			search.q,
			(value) => `"${value}"`,
			() => setSearch({ q: undefined }),
		),
		chip(
			"hasTools",
			search.hasTools === true ? "used tools" : undefined,
			(value) => value,
			() => setSearch({ hasTools: undefined }),
		),
		rangeChip(
			"cost",
			search.costMin,
			search.costMax,
			(value) => formatCost(value) ?? "",
			() => setSearch({ costMin: undefined, costMax: undefined }),
		),
		rangeChip(
			"duration",
			search.durationMin,
			search.durationMax,
			(value) => `${value}s`,
			() => setSearch({ durationMin: undefined, durationMax: undefined }),
		),
		rangeChip(
			"turns",
			search.turnMin,
			search.turnMax,
			(value) => String(value),
			() => setSearch({ turnMin: undefined, turnMax: undefined }),
		),
		rangeChip(
			"tokens",
			search.tokenMin,
			search.tokenMax,
			(value) => String(value),
			() => setSearch({ tokenMin: undefined, tokenMax: undefined }),
		),
	].filter((entry): entry is ActiveJourneyFilter => entry != null)

	const clearAllFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
				sort: search.sort,
				sortDirection: search.sortDirection,
			},
		})
	}

	const label = rangeLabel(search.timePreset, Boolean(search.startTime && search.endTime))

	const headerActions = (
		<>
			<div className="mr-2 hidden items-center gap-4 sm:flex">
				<span className="flex items-baseline gap-1.5 font-mono text-sm whitespace-nowrap">
					<span className="font-medium tabular-nums">{journeys.length.toLocaleString()}</span>
					<span className="text-muted-foreground">journeys</span>
				</span>
				{liveCount > 0 && (
					<span
						className="flex items-center gap-1.5 font-mono text-sm whitespace-nowrap"
						title="Best-effort estimate: a journey counts as live if it emitted a span in the last 2 minutes. It may not be 100% accurate in edge cases, e.g. a crashed process or a long gap between spans."
					>
						<span className="size-1.5 rounded-full bg-success" aria-hidden />
						<span className="font-medium tabular-nums">{liveCount}</span>
						<span className="text-muted-foreground">live</span>
					</span>
				)}
				{spent > 0 && (
					<span
						className="flex items-baseline gap-1.5 font-mono text-sm whitespace-nowrap"
						title="Total cost of the journeys loaded below"
					>
						<span className="font-medium text-primary tabular-nums">{formatCost(spent)}</span>
						<span className="text-muted-foreground">spent</span>
					</span>
				)}
			</div>
			<TimeRangeHeaderControls
				startTime={search.startTime ?? startTime}
				endTime={search.endTime ?? endTime}
				presetValue={search.timePreset ?? (search.startTime ? undefined : "24h")}
				defaultPreset="24h"
				onTimeChange={handleTimeChange}
			/>
		</>
	)

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "24h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[{ label: "Journeys" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Filters>
						<JourneysFilterSidebar facetsResult={facetsResult} />
					</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								title="Agent Journeys"
								description="Every end-to-end agent conversation, reconstructed from spans."
							>
								{headerActions}
							</DashboardLayout.Header>
							<JourneysToolbar
								query={search.q ?? ""}
								onSearch={(value) => setSearch({ q: value })}
								erroredCount={erroredCount}
								truncatedCount={truncatedCount}
								toolCount={facets?.toolCount ?? 0}
								statusError={search.status === "error"}
								truncatedOnly={search.finishReason === "length"}
								expensiveOnly={search.costMin === COST_OUTLIER_DOLLARS}
								usedTools={search.hasTools === true}
								onToggleStatusError={() =>
									setSearch({
										status: search.status === "error" ? undefined : "error",
									})
								}
								onToggleTruncated={() =>
									setSearch({
										finishReason: search.finishReason === "length" ? undefined : "length",
									})
								}
								onToggleExpensive={() =>
									setSearch({
										costMin:
											search.costMin === COST_OUTLIER_DOLLARS
												? undefined
												: COST_OUTLIER_DOLLARS,
									})
								}
								onToggleUsedTools={() =>
									setSearch({
										hasTools: search.hasTools === true ? undefined : true,
									})
								}
								sort={activeSort}
								onSortChange={(next) => setSearch({ sort: next })}
								waiting={firstPageResult.waiting}
							/>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							{Result.builder(firstPageResult)
								.onInitial(() => <JourneysListSkeleton />)
								.onError((error) => (
									<QueryErrorState error={error} titleOverride="Couldn't load journeys" />
								))
								.onSuccess(() =>
									journeys.length === 0 ? (
										filtersApplied ? (
											<JourneysEmptyFilters
												startTime={startTime}
												endTime={endTime}
												rangeLabel={label}
												filters={activeFilterChips}
												onClearAll={clearAllFilters}
											/>
										) : (
											<JourneysEmptyRange
												rangeLabel={label}
												onWiden={() =>
													handleTimeChange({ presetValue: "7d" } as TimeRange)
												}
											/>
										)
									) : (
										<JourneysList
											journeys={journeys}
											hasMore={hasNextPage}
											isCapped={isCapped}
											loadingMore={isFetchingNextPage}
											onReachEnd={fetchNextPage}
											sort={{
												active: activeSort,
												direction: search.sortDirection ?? "desc",
												onSort: handleColumnSort,
											}}
										/>
									),
								)
								.render()}
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}

function chip(
	key: string,
	value: string | undefined,
	format: (value: string) => string,
	onClear: () => void,
): ActiveJourneyFilter | undefined {
	if (!value) return undefined
	return { key, label: format(value), onClear }
}

function rangeChip(
	key: string,
	min: number | undefined,
	max: number | undefined,
	format: (value: number) => string,
	onClear: () => void,
): ActiveJourneyFilter | undefined {
	if (min == null && max == null) return undefined
	const label =
		min != null && max != null
			? `${key} ${format(min)}–${format(max)}`
			: min != null
				? `${key} > ${format(min)}`
				: `${key} < ${format(max!)}`
	return { key, label, onClear }
}
