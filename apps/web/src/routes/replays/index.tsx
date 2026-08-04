import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { SessionsList } from "@/components/replays/sessions-list"
import { ActiveUserFilter } from "@/components/replays/active-user-filter"
import { ReplaysFilterSidebar } from "@/components/replays/replays-filter-sidebar"
import { ReplaysToolbar } from "@/components/replays/replays-toolbar"
import { BooleanFromStringParam, NumberFromStringParam } from "@/lib/search-params"
import { replaysFilterInputs } from "@/components/replays/replays-filter-inputs"
import { REPLAYS_PAGE_SIZE, useInfiniteReplays } from "@/hooks/use-infinite-replays"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { listReplaysResultAtom, replaysFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import type { TimeRange } from "@/components/time-range-picker/types"
import { QueryErrorState } from "@/components/common/query-error-state"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { ToolbarStat } from "@maple/ui/components/toolbar"

const replaysSearchSchema = Schema.Struct({
	service: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	userId: Schema.optional(Schema.String),
	/** Scope to one browser — spans signed-out marketing and signed-in app sessions. */
	visitorId: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	// Session-time range filters, in whole seconds (human-friendly URLs). Mapped
	// to ms before hitting the warehouse. Union accepts a JS-set number or a
	// URL-parsed string, mirroring hasErrors.
	durationMin: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	durationMax: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	activeMin: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	activeMax: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	q: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/replays/")({
	component: ReplaysPage,
	validateSearch: Schema.toStandardSchemaV1(replaysSearchSchema),
	loaderDeps: ({ search }) => search,
	// Both queries are on the critical path and neither is cached server-side, so
	// starting them here rather than on mount is worth real time: the router runs
	// `defaultPreload: "intent"`, which fires this on hover — ahead of the route
	// chunk evaluating and React committing. Mount is fire-and-forget; the
	// component reads the same entries and renders its skeleton meanwhile.
	loader: ({ context, deps }) => {
		const filterInputs = replaysFilterInputs(deps)
		context.effectRegistry.mount(
			listReplaysResultAtom({ data: { ...filterInputs, limit: REPLAYS_PAGE_SIZE, offset: 0 } }),
		)
		context.effectRegistry.mount(replaysFacetsResultAtom({ data: filterInputs }))
	},
})

function ReplaysPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const filterInputs = useMemo(
		() => replaysFilterInputs(search),
		[
			search.startTime,
			search.endTime,
			search.timePreset,
			search.service,
			search.browser,
			search.country,
			search.deviceType,
			search.userId,
			search.visitorId,
			search.hasErrors,
			search.q,
			search.durationMin,
			search.durationMax,
			search.activeMin,
			search.activeMax,
		],
	)
	const { startTime, endTime } = filterInputs

	const { firstPageResult, allData, hasNextPage, isCapped, isFetchingNextPage, fetchNextPage } =
		useInfiniteReplays(filterInputs)
	const facetsResult = useAtomValue(replaysFacetsResultAtom({ data: filterInputs }))

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => applyTimeRangeSearch(prev, range),
		})
	}

	const handleSearch = (value: string | undefined) => {
		navigate({ search: (prev) => ({ ...prev, q: value }) })
	}

	const handleUserFilter = (value: string | undefined) => {
		navigate({ search: (prev) => ({ ...prev, userId: value }) })
	}

	const handleVisitorFilter = (value: string | undefined) => {
		navigate({ search: (prev) => ({ ...prev, visitorId: value }) })
	}

	const sessions = allData
	const errorSessions = Result.isSuccess(facetsResult) ? facetsResult.value.errorCount : 0
	const durationP95 = Result.isSuccess(facetsResult) ? facetsResult.value.durationP95 : undefined
	// "Engaged" chip mirrors the sidebar preset exactly (activeMin=30, no max), so
	// toggling either surface keeps the other in sync.
	const engagedOnly = search.activeMin === 30 && search.activeMax == null

	const headerActions = (
		<>
			<div className="mr-2 hidden items-center gap-4 sm:flex">
				<ToolbarStat value={sessions.length} label="sessions" />
				<ToolbarStat value={sessions.filter((s) => s.status === "active").length} label="live" dot />
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

	const toolbar = (
		<ReplaysToolbar
			query={search.q ?? ""}
			onSearch={handleSearch}
			errorSessions={errorSessions}
			errorsOnly={search.hasErrors === true}
			onToggleErrorsOnly={() =>
				navigate({
					search: (prev) => ({ ...prev, hasErrors: prev.hasErrors ? undefined : true }),
				})
			}
			engagedOnly={engagedOnly}
			onToggleEngagedOnly={() =>
				navigate({
					search: (prev) =>
						engagedOnly
							? { ...prev, activeMin: undefined }
							: { ...prev, activeMin: 30, activeMax: undefined },
				})
			}
			waiting={firstPageResult.waiting}
		/>
	)

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "24h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[{ label: "Session Replays" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Filters>
						<ReplaysFilterSidebar facetsResult={facetsResult} />
					</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								title="Session Replays"
								description="Watch what your users actually saw and did in the browser."
							>
								{headerActions}
							</DashboardLayout.Header>
							{toolbar}
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							{search.userId && (
								<ActiveUserFilter
									userId={search.userId}
									count={sessions.length}
									onClear={() => handleUserFilter(undefined)}
								/>
							)}
							{search.visitorId && (
								<ActiveUserFilter
									userId={search.visitorId}
									count={sessions.length}
									label="Sessions from visitor"
									clearLabel="Clear visitor filter"
									onClear={() => handleVisitorFilter(undefined)}
								/>
							)}
							{Result.builder(firstPageResult)
								.onInitial(() => (
									<div className="divide-y divide-border">
										{Array.from({ length: 8 }).map((_, i) => (
											<div key={i} className="flex items-center gap-3 py-2.5">
												<Skeleton className="size-8 shrink-0 rounded-full" />
												<div className="flex-1 space-y-1.5">
													<Skeleton className="h-3.5 w-48" />
													<Skeleton className="h-3 w-64" />
												</div>
												<Skeleton className="hidden h-3.5 w-40 sm:block" />
											</div>
										))}
									</div>
								))
								.onError((error) => (
									<QueryErrorState
										error={error}
										titleOverride="Failed to load session replays"
									/>
								))
								.onSuccess(() => (
									<SessionsList
										sessions={allData}
										hasMore={hasNextPage}
										isCapped={isCapped}
										loadingMore={isFetchingNextPage}
										onReachEnd={fetchNextPage}
										durationP95={durationP95}
									/>
								))
								.render()}
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
