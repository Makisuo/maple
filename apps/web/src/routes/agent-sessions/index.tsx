import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { AiSessionSortDir, AiSessionSortKey } from "@maple/domain/http"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { AgentSessionsList } from "@/components/agent-sessions/agent-sessions-list"
import { AgentSessionsFilterSidebar } from "@/components/agent-sessions/agent-sessions-filter-sidebar"
import { AgentSessionsToolbar } from "@/components/agent-sessions/agent-sessions-toolbar"
import {
	agentSessionsFilterInputs,
	sortOptionFor,
} from "@/components/agent-sessions/agent-sessions-filter-inputs"
import { NotFoundError } from "@/components/route-error"
import { QueryErrorState } from "@/components/common/query-error-state"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { BooleanFromStringParam, NumberFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import { aiSessionsFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useInfiniteAiSessions } from "@/hooks/use-infinite-ai-sessions"
import { useOrganizationFeatureFlags } from "@/hooks/use-organization-feature-flags"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

/**
 * The list's window. There is no picker: sessions are read newest-first over
 * the last week and paged from there, and the sidebar counts the same week.
 * A wider window would only move the point the infinite scroll ends at, and
 * the counted filters have to describe the population the list pages — see
 * `aiSessionFacetsQuery`.
 */
export const AGENT_SESSIONS_WINDOW = "7d"

const BooleanParam = Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam]))
const NumberParam = Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam]))

const agentSessionsSearchSchema = Schema.Struct({
	/** Vendor ids as stamped by the gateway (e.g. `eve`), not display labels. */
	vendors: OptionalStringArrayParam,
	services: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	models: OptionalStringArrayParam,
	agents: OptionalStringArrayParam,
	tools: OptionalStringArrayParam,
	/** Session or trace id prefix. */
	q: Schema.optional(Schema.String),
	hasErrors: BooleanParam,
	/** Hide the `trace:` sessions — traces whose vendor exposes no session key. */
	grouped: BooleanParam,
	/** Seconds, like the replays list. */
	durationMin: NumberParam,
	durationMax: NumberParam,
	costMin: NumberParam,
	costMax: NumberParam,
	tokensMin: NumberParam,
	tokensMax: NumberParam,
	llmCallsMin: NumberParam,
	llmCallsMax: NumberParam,
	toolCallsMin: NumberParam,
	toolCallsMax: NumberParam,
	sortBy: Schema.optional(AiSessionSortKey),
	sortDir: Schema.optional(AiSessionSortDir),
})

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
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Agent Sessions" }]} />
			<DashboardLayout.Body>
				<AgentSessionsBody />
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

/** The `Filters | Content` siblings, so both share one resolved window. */
function AgentSessionsBody() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	// Resolved once per mount and snapped to the cache grid, so the atom key
	// holds still between navigations.
	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, AGENT_SESSIONS_WINDOW)
	// Memoized on the search by VALUE, not by the reference the router hands
	// back: the hook keys its accumulated pages on these inputs, and a fresh
	// object per render would reset them every time.
	const searchKey = JSON.stringify(search)
	const filterInputs = useMemo(
		() => agentSessionsFilterInputs(search, { startTime, endTime }),
		[searchKey, startTime, endTime],
	)
	const { firstPageResult, allData, hasNextPage, isCapped, isFetchingNextPage, fetchNextPage } =
		useInfiniteAiSessions(filterInputs)
	// The sidebar's counts come from the UNFILTERED window, so picking a vendor
	// doesn't erase the others from the list. Plain useAtomValue keeps this off
	// the Reload subscription — the facets refetch when the window rolls, which
	// is enough.
	const facetsResult = useAtomValue(aiSessionsFacetsResultAtom({ data: { startTime, endTime } }))
	const sessions = allData
	const sortOption = sortOptionFor(search.sortBy, search.sortDir)

	const toolbar = (
		<AgentSessionsToolbar
			sessionCount={sessions.length}
			query={search.q ?? ""}
			onSearch={(value) => navigate({ search: (prev) => ({ ...prev, q: value }) })}
			errorsOnly={search.hasErrors === true}
			onToggleErrorsOnly={() =>
				navigate({
					search: (prev) => ({
						...prev,
						hasErrors: prev.hasErrors ? undefined : true,
					}),
				})
			}
			sortKey={sortOption.key}
			// The default sort leaves the URL clean, so a shared link only carries
			// a sort when one was chosen.
			onSortChange={(option) =>
				navigate({
					search: (prev) => ({
						...prev,
						sortBy:
							option.sortBy === "startTime" && option.sortDir === "desc"
								? undefined
								: option.sortBy,
						sortDir:
							option.sortBy === "startTime" && option.sortDir === "desc"
								? undefined
								: option.sortDir,
					}),
				})
			}
			waiting={firstPageResult.waiting}
		/>
	)

	return (
		<>
			<DashboardLayout.Filters>
				<AgentSessionsFilterSidebar facetsResult={facetsResult} />
			</DashboardLayout.Filters>
			<DashboardLayout.Content>
				<DashboardLayout.Sticky>{toolbar}</DashboardLayout.Sticky>
				<DashboardLayout.Scroll>
					{Result.builder(firstPageResult)
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
						.onSuccess(() => (
							<AgentSessionsList
								sessions={allData}
								hasMore={hasNextPage}
								isCapped={isCapped}
								loadingMore={isFetchingNextPage}
								onReachEnd={fetchNextPage}
							/>
						))
						.render()}
				</DashboardLayout.Scroll>
			</DashboardLayout.Content>
		</>
	)
}
