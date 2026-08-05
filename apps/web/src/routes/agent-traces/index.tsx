import { useMemo } from "react"
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { useAgentTracingEnabled } from "@/hooks/use-agent-tracing-enabled"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { BooleanFromStringParam, NumberFromStringParam } from "@/lib/search-params"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	agentTraceFacetsResultAtom,
	listAgentTracesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import type { TimeRange } from "@/components/time-range-picker/types"

import { AgentTracesFilterSidebar } from "@/components/agent-traces/overview/agent-traces-filter-sidebar"
import { AgentTracesToolbar } from "@/components/agent-traces/overview/agent-traces-toolbar"
import {
	AgentTracesList,
	AgentTracesListSkeleton,
} from "@/components/agent-traces/overview/agent-traces-list"
import {
	AgentTracesEmptyFilters,
	AgentTracesEmptyRange,
	type ActiveAgentTraceFilter,
} from "@/components/agent-traces/overview/agent-traces-empty-states"
import {
	DEFAULT_AGENT_TRACE_SORT,
	hasActiveAgentTraceFilters,
	agentTracesFilterInputs,
	agentTracesSortInputs,
	type AgentTraceSort,
} from "@/components/agent-traces/overview/agent-traces-filter-inputs"
import {
	AGENT_TRACES_PAGE_SIZE,
	useInfiniteAgentTraces,
} from "@/components/agent-traces/overview/use-infinite-agent-traces"
import { formatCost } from "@/components/agent-traces/overview/agent-traces-format"

const NumberParam = Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam]))

const agentTracesSearchSchema = Schema.Struct({
	status: Schema.optional(Schema.Literals(["ok", "error", "running"])),
	finishReason: Schema.optional(Schema.String),
	agent: Schema.optional(Schema.String),
	workflow: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	provider: Schema.optional(Schema.String),
	service: Schema.optional(Schema.String),
	hasTools: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	/** Substring over the title sample and the agent trace id. Written by both the
	 *  toolbar search and the sidebar's "Agent trace ID" field. */
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

export const Route = createFileRoute("/agent-traces/")({
	component: AgentTracesPage,
	validateSearch: Schema.toStandardSchemaV1(agentTracesSearchSchema),
	loaderDeps: ({ search }) => search,
	// Both queries are on the critical path and neither is cached server-side, so
	// starting them on `intent` preload beats waiting for the route chunk and the
	// first commit. Fire-and-forget: the component reads the same entries.
	loader: ({ context, deps }) => {
		const filterInputs = agentTracesFilterInputs(deps)
		context.effectRegistry.mount(
			listAgentTracesResultAtom({
				data: {
					...filterInputs,
					...agentTracesSortInputs(deps),
					limit: AGENT_TRACES_PAGE_SIZE,
					offset: 0,
				},
			}),
		)
		context.effectRegistry.mount(agentTraceFacetsResultAtom({ data: filterInputs }))
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

function AgentTracesPage() {
	const agentTracingEnabled = useAgentTracingEnabled()
	if (!agentTracingEnabled) return <Navigate to="/" replace />
	return <AgentTracesPageContent />
}

function AgentTracesPageContent() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const filterInputs = useMemo(
		() => agentTracesFilterInputs(search),
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
	const sortInputs = useMemo(() => agentTracesSortInputs(search), [search.sort, search.sortDirection])
	const listInputs = useMemo(() => ({ ...filterInputs, ...sortInputs }), [filterInputs, sortInputs])

	const { firstPageResult, allData, hasNextPage, isCapped, isFetchingNextPage, fetchNextPage } =
		useInfiniteAgentTraces(listInputs)
	const facetsResult = useAtomValue(agentTraceFacetsResultAtom({ data: filterInputs }))

	const agentTraces = allData
	const liveCount = agentTraces.filter((agentTrace) => agentTrace.status === "running").length
	// Both header figures describe what's loaded, not the whole window — the list
	// is capped, and a total the list can't show you is a number you can't act on.
	const spent = agentTraces.reduce((sum, agentTrace) => sum + (agentTrace.cost ?? 0), 0)

	const setSearch = (patch: Record<string, unknown>) => {
		navigate({ search: (prev) => ({ ...prev, ...patch }) })
	}

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => applyTimeRangeSearch(prev, range),
		})
	}

	const activeSort: AgentTraceSort = search.sort ?? DEFAULT_AGENT_TRACE_SORT

	const filtersApplied = hasActiveAgentTraceFilters(search)

	const activeFilterChips: ReadonlyArray<ActiveAgentTraceFilter> = [
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
	].filter((entry): entry is ActiveAgentTraceFilter => entry != null)

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
					<span className="font-medium tabular-nums">{agentTraces.length.toLocaleString()}</span>
					<span className="text-muted-foreground">agent traces</span>
				</span>
				{liveCount > 0 && (
					<span
						className="flex items-center gap-1.5 font-mono text-sm whitespace-nowrap"
						title="Best-effort estimate: an agent trace counts as live if it emitted a span in the last 2 minutes. It may not be 100% accurate in edge cases, e.g. a crashed process or a long gap between spans."
					>
						<span className="size-1.5 rounded-full bg-success" aria-hidden />
						<span className="font-medium tabular-nums">{liveCount}</span>
						<span className="text-muted-foreground">live</span>
					</span>
				)}
				{spent > 0 && (
					<span
						className="flex items-baseline gap-1.5 font-mono text-sm whitespace-nowrap"
						title="Total cost of the agent traces loaded below"
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
				<DashboardLayout.Breadcrumbs items={[{ label: "Agent Traces" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Filters>
						<AgentTracesFilterSidebar facetsResult={facetsResult} />
					</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								title="Agent Traces"
								description="Every end-to-end agent conversation, reconstructed from spans."
							>
								{headerActions}
							</DashboardLayout.Header>
							<AgentTracesToolbar
								query={search.q ?? ""}
								onSearch={(value) => setSearch({ q: value })}
								sort={activeSort}
								onSortChange={(next) => setSearch({ sort: next })}
							/>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							{Result.builder(firstPageResult)
								.onInitial(() => <AgentTracesListSkeleton />)
								.onError((error) => (
									<QueryErrorState
										error={error}
										titleOverride="Couldn't load agent traces"
									/>
								))
								.onSuccess(() =>
									agentTraces.length === 0 ? (
										filtersApplied ? (
											<AgentTracesEmptyFilters
												startTime={startTime}
												endTime={endTime}
												rangeLabel={label}
												filters={activeFilterChips}
												onClearAll={clearAllFilters}
											/>
										) : (
											<AgentTracesEmptyRange
												rangeLabel={label}
												onWiden={() =>
													handleTimeChange({ presetValue: "7d" } as TimeRange)
												}
											/>
										)
									) : (
										<AgentTracesList
											agentTraces={agentTraces}
											hasMore={hasNextPage}
											isCapped={isCapped}
											loadingMore={isFetchingNextPage}
											onReachEnd={fetchNextPage}
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
): ActiveAgentTraceFilter | undefined {
	if (!value) return undefined
	return { key, label: format(value), onClear }
}

function rangeChip(
	key: string,
	min: number | undefined,
	max: number | undefined,
	format: (value: number) => string,
	onClear: () => void,
): ActiveAgentTraceFilter | undefined {
	if (min == null && max == null) return undefined
	const label =
		min != null && max != null
			? `${key} ${format(min)}–${format(max)}`
			: min != null
				? `${key} > ${format(min)}`
				: `${key} < ${format(max!)}`
	return { key, label, onClear }
}
