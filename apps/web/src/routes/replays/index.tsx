import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { SessionsList } from "@/components/replays/sessions-list"
import { ActiveUserFilter } from "@/components/replays/active-user-filter"
import { ReplaysFilterSidebar } from "@/components/replays/replays-filter-sidebar"
import { ReplaysToolbar } from "@/components/replays/replays-toolbar"
import { BooleanFromStringParam, NumberFromStringParam } from "@/lib/search-params"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useInfiniteReplays } from "@/hooks/use-infinite-replays"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { replaysFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import type { TimeRange } from "@/components/time-range-picker/types"
import { QueryErrorState } from "@/components/common/query-error-state"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

const replaysSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
	service: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	userId: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	// Session-time range filters, in whole seconds (human-friendly URLs). Mapped
	// to ms before hitting the warehouse. Union accepts a JS-set number or a
	// URL-parsed string, mirroring hasErrors.
	durationMin: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	durationMax: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	activeMin: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	activeMax: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	q: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/replays/"))({
	component: ReplaysPage,
	validateSearch: Schema.toStandardSchemaV1(replaysSearchSchema),
})

function ReplaysPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "24h",
	)

	const filterInputs = useMemo(
		() => ({
			startTime,
			endTime,
			serviceName: search.service,
			browser: search.browser,
			country: search.country,
			deviceType: search.deviceType,
			userId: search.userId,
			hasErrors: search.hasErrors,
			search: search.q,
			// URL params are whole seconds; the warehouse filters in ms.
			durationMinMs: search.durationMin != null ? search.durationMin * 1000 : undefined,
			durationMaxMs: search.durationMax != null ? search.durationMax * 1000 : undefined,
			activeTimeMinMs: search.activeMin != null ? search.activeMin * 1000 : undefined,
			activeTimeMaxMs: search.activeMax != null ? search.activeMax * 1000 : undefined,
		}),
		[
			startTime,
			endTime,
			search.service,
			search.browser,
			search.country,
			search.deviceType,
			search.userId,
			search.hasErrors,
			search.q,
			search.durationMin,
			search.durationMax,
			search.activeMin,
			search.activeMax,
		],
	)

	const { firstPageResult, allData, hasNextPage, isFetchingNextPage, fetchNextPage } =
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

	const sessions = allData
	const errorSessions = Result.isSuccess(facetsResult) ? facetsResult.value.errorCount : 0

	const titleContent = <h1 className="truncate text-2xl font-semibold tracking-tight">Session Replays</h1>

	const headerActions = (
		<TimeRangeHeaderControls
			startTime={search.startTime ?? startTime}
			endTime={search.endTime ?? endTime}
			presetValue={search.timePreset ?? (search.startTime ? undefined : "24h")}
			defaultPreset="24h"
			onTimeChange={handleTimeChange}
		/>
	)

	const toolbar = (
		<ReplaysToolbar
			query={search.q ?? ""}
			onSearch={handleSearch}
			totalSessions={sessions.length}
			activeSessions={sessions.filter((s) => s.status === "active").length}
			errorSessions={errorSessions}
			waiting={firstPageResult.waiting}
		/>
	)

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "24h"}>
			<DashboardLayout
				breadcrumbs={[{ label: "Session Replays" }]}
				titleContent={titleContent}
				description="Watch what your users actually saw and did in the browser."
				headerActions={headerActions}
				filterSidebar={<ReplaysFilterSidebar facetsResult={facetsResult} />}
				stickyContent={toolbar}
			>
				{search.userId && (
					<ActiveUserFilter
						userId={search.userId}
						count={sessions.length}
						onClear={() => handleUserFilter(undefined)}
					/>
				)}
				{Result.builder(firstPageResult)
					.onInitial(() => (
						<div className="space-y-2">
							{Array.from({ length: 6 }).map((_, i) => (
								<Skeleton key={i} className="h-[68px] w-full rounded-xl" />
							))}
						</div>
					))
					.onError((error) => (
						<QueryErrorState error={error} titleOverride="Failed to load session replays" />
					))
					.onSuccess(() => (
						<SessionsList
							sessions={allData}
							hasMore={hasNextPage}
							loadingMore={isFetchingNextPage}
							onReachEnd={fetchNextPage}
						/>
					))
					.render()}
			</DashboardLayout>
		</PageRefreshProvider>
	)
}
