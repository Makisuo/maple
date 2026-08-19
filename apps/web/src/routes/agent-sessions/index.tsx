import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { AgentSessionsList } from "@/components/agent-sessions/agent-sessions-list"
import { AgentSessionsFilterSidebar } from "@/components/agent-sessions/agent-sessions-filter-sidebar"
import { NotFoundError } from "@/components/route-error"
import { QueryErrorState } from "@/components/common/query-error-state"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { listAiSessionsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import type { TimeRange } from "@/components/time-range-picker/types"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { useOrganizationFeatureFlags } from "@/hooks/use-organization-feature-flags"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { ToolbarStat } from "@maple/ui/components/toolbar"

const agentSessionsSearchSchema = Schema.Struct({
	/** Vendor id as stamped by the gateway (e.g. `eve`), not the display label. */
	vendor: Schema.optional(Schema.String),
	service: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

const AGENT_SESSIONS_LIMIT = 50

export const Route = createFileRoute("/agent-sessions/")({
	component: AgentSessionsPage,
	validateSearch: Schema.toStandardSchemaV1(agentSessionsSearchSchema),
})

/**
 * Behind the `agent_tracing` org rollout flag. The gate lives in the component
 * (not `beforeLoad`) because router context carries no flags, and it checks
 * `isLoaded` first so an entitled org doesn't get a not-found flash while Clerk
 * answers. The warehouse read lives in the gated content component, so an
 * unflagged org never fires the query — which is also why there is no route
 * `loader` warming the atom the way `/replays` does: a loader runs regardless
 * of the flag, so the prefetch-on-hover win would cost every unflagged org a
 * warehouse query. Entitled orgs pay full latency on mount instead; revisit
 * when the flag retires.
 */
function AgentSessionsPage() {
	const { flags, isLoaded } = useOrganizationFeatureFlags()
	if (!isLoaded) return null
	if (!flags.agentTracing) return <NotFoundError />
	return <AgentSessionsPageContent />
}

function AgentSessionsPageContent() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => applyTimeRangeSearch(prev, range),
		})
	}

	return (
		// No preset default while an absolute range is active — mirrors the
		// picker's own presetValue expression below.
		<PageRefreshProvider timePreset={search.timePreset ?? (search.startTime ? undefined : "24h")}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[{ label: "Agent Sessions" }]} />
				<DashboardLayout.Body>
					<AgentSessionsBody onTimeChange={handleTimeChange} />
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}

/**
 * Split from the page so `useEffectiveTimeRange` runs inside
 * `PageRefreshProvider` — the refresh button re-resolves a preset window only
 * for hooks that can see the provider's refresh version. Renders the
 * `Filters | Content` siblings, so both share one resolved window.
 */
function AgentSessionsBody({
	onTimeChange,
}: {
	onTimeChange: (range: TimeRange, options?: { replace?: boolean }) => void
}) {
	const search = Route.useSearch()
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "24h",
	)
	const window = { startTime, endTime, limit: AGENT_SESSIONS_LIMIT }
	// Refreshable (not plain useAtomValue): on an absolute time range the atom
	// key never rolls, so Reload only works through the refresh subscription.
	const result = useRetainedRefreshableResultValue(
		listAiSessionsResultAtom({
			data: {
				...window,
				vendorIds: search.vendor ? [search.vendor] : undefined,
				serviceNames: search.service ? [search.service] : undefined,
			},
		}),
	)
	// The sidebar's option lists come from the UNFILTERED window, so picking a
	// vendor doesn't erase the others from the list. With no filter active this
	// is the same atom entry as `result` (undefined fields drop from the cache
	// key), so it costs nothing; plain useAtomValue keeps it off the Reload
	// subscription — options refetch when the window rolls, which is enough.
	const optionsResult = useAtomValue(listAiSessionsResultAtom({ data: window }))
	const sessions = Result.isSuccess(result) ? result.value.data : []

	const headerActions = (
		<div className="flex flex-wrap items-center gap-2">
			<div className="hidden items-center gap-4 sm:flex">
				<ToolbarStat value={sessions.length} label="sessions" />
			</div>
			<TimeRangeHeaderControls
				startTime={search.startTime ?? startTime}
				endTime={search.endTime ?? endTime}
				presetValue={search.timePreset ?? (search.startTime ? undefined : "24h")}
				defaultPreset="24h"
				onTimeChange={onTimeChange}
			/>
		</div>
	)

	return (
		<>
			<DashboardLayout.Filters>
				<AgentSessionsFilterSidebar optionsResult={optionsResult} />
			</DashboardLayout.Filters>
			<DashboardLayout.Content>
				<DashboardLayout.Sticky>
					<DashboardLayout.Header
						title="Agent Sessions"
						description="Follow what your AI agents did, session by session."
					>
						{headerActions}
					</DashboardLayout.Header>
				</DashboardLayout.Sticky>
				<DashboardLayout.Scroll>
					{Result.builder(result)
						.onInitial(() => (
							<div className="divide-y divide-border">
								{Array.from({ length: 8 }).map((_, i) => (
									<div key={i} className="flex items-center gap-3 py-3">
										<div className="flex-1 space-y-1.5">
											<Skeleton className="h-3.5 w-64" />
											<Skeleton className="h-3 w-28" />
										</div>
										<Skeleton className="hidden h-3.5 w-40 sm:block" />
									</div>
								))}
							</div>
						))
						.onError((error) => (
							<QueryErrorState error={error} titleOverride="Failed to load agent sessions" />
						))
						.onSuccess((value) => (
							<AgentSessionsList sessions={value.data} limit={AGENT_SESSIONS_LIMIT} />
						))
						.render()}
				</DashboardLayout.Scroll>
			</DashboardLayout.Content>
		</>
	)
}
