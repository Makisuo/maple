import { warmAtoms } from "@effect-router/core"
import { useMemo } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { AI_VENDOR_LABELS } from "@maple/domain/ai"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { BooleanFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	agentSessionsFacetsResultAtom,
	listAgentSessionsResultAtom,
	listAgentTracesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import type { TimeRange } from "@/components/time-range-picker/types"
import { resolveEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { QueryErrorState } from "@/components/common/query-error-state"
import { FilterSection, SingleCheckboxFilter } from "@/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Badge } from "@maple/ui/components/ui/badge"

// THROWAWAY product scratchpad (owner-flagged): first UI over the AI
// classification read path, to try out what "Agent Sessions" should even be.
// Expect a full rebuild once the product shape settles — don't extract
// abstractions from this file, and don't emulate it.

const agentSessionsSearchSchema = Schema.Struct({
	tab: Schema.optional(Schema.Literals(["sessions", "traces"])),
	vendors: OptionalStringArrayParam,
	services: OptionalStringArrayParam,
	hasErrors: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	...TimeRangeSearchFields,
})

type AgentSessionsSearch = typeof agentSessionsSearchSchema.Type

const filterInputs = (search: AgentSessionsSearch) => {
	const { startTime, endTime } = resolveEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "24h",
	)
	return {
		startTime,
		endTime,
		vendors: search.vendors,
		serviceNames: search.services,
		hasErrors: search.hasErrors,
	}
}

const PAGE_SIZE = 50

export const Route = createFileRoute("/agent-sessions/")({
	component: AgentSessionsPage,
	validateSearch: Schema.toStandardSchemaV1(agentSessionsSearchSchema),
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) => {
		const inputs = filterInputs(deps)
		const tab = deps.tab ?? "sessions"
		warmAtoms(context.effectRegistry, [
			tab === "sessions"
				? listAgentSessionsResultAtom({ data: { ...inputs, limit: PAGE_SIZE, offset: 0 } })
				: listAgentTracesResultAtom({ data: { ...inputs, limit: PAGE_SIZE, offset: 0 } }),
			agentSessionsFacetsResultAtom({ data: { ...inputs, tab } }),
		])
	},
})

const vendorLabel = (slug: string) => (AI_VENDOR_LABELS as Record<string, string>)[slug] ?? slug

/** Write-side AiSessionKeyState enum (ai_classifier.rs), for the traces tab. */
const KEY_STATE_LABELS: Record<number, string> = {
	1: "no session rules",
	2: "not authoritative",
	3: "key absent",
	4: "key invalid",
	5: "sub-session",
	6: "in session",
}

const formatMs = (ms: number) => {
	if (!Number.isFinite(ms) || ms < 0) return "–"
	if (ms < 1000) return `${Math.round(ms)}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

const formatTime = (ts: string) => ts.slice(0, 19)

function VendorChips({ vendors }: { vendors: ReadonlyArray<string> }) {
	return (
		<span className="flex flex-wrap gap-1">
			{vendors.map((v) => (
				<Badge key={v} variant="secondary" className="text-[10px]">
					{vendorLabel(v)}
				</Badge>
			))}
		</span>
	)
}

function AgentSessionsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const tab = search.tab ?? "sessions"

	const inputs = useMemo(
		() => filterInputs(search),
		[
			search.startTime,
			search.endTime,
			search.timePreset,
			search.vendors,
			search.services,
			search.hasErrors,
		],
	)

	const sessionsResult = useAtomValue(
		listAgentSessionsResultAtom({ data: { ...inputs, limit: PAGE_SIZE, offset: 0 } }),
	)
	const tracesResult = useAtomValue(
		listAgentTracesResultAtom({ data: { ...inputs, limit: PAGE_SIZE, offset: 0 } }),
	)
	const facetsResult = useAtomValue(agentSessionsFacetsResultAtom({ data: { ...inputs, tab } }))

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({ replace: options?.replace, search: (prev) => applyTimeRangeSearch(prev, range) })
	}

	const hasActiveFilters =
		(search.vendors?.length ?? 0) > 0 || (search.services?.length ?? 0) > 0 || search.hasErrors === true

	const sidebar = Result.builder(facetsResult)
		.onInitial(() => <FilterSidebarLoading />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((facets, result) => (
			<FilterSidebarFrame waiting={result.waiting}>
				<FilterSidebarHeader
					canClear={hasActiveFilters}
					onClear={() =>
						navigate({
							search: (prev) => ({
								...prev,
								vendors: undefined,
								services: undefined,
								hasErrors: undefined,
							}),
						})
					}
				/>
				<FilterSidebarBody>
					<FilterSection
						title="Vendor"
						options={facets.vendors.map((f) => ({ name: f.name, count: f.count }))}
						selected={search.vendors ?? []}
						onChange={(selected) =>
							navigate({
								search: (prev) => ({
									...prev,
									vendors: selected.length > 0 ? selected : undefined,
								}),
							})
						}
						getOptionLabel={vendorLabel}
					/>
					<FilterSection
						title="Service"
						options={facets.services.map((f) => ({ name: f.name, count: f.count }))}
						selected={search.services ?? []}
						onChange={(selected) =>
							navigate({
								search: (prev) => ({
									...prev,
									services: selected.length > 0 ? selected : undefined,
								}),
							})
						}
					/>
					<SingleCheckboxFilter
						title="Has errors"
						checked={search.hasErrors === true}
						count={facets.errorCount}
						onChange={(checked) =>
							navigate({ search: (prev) => ({ ...prev, hasErrors: checked ? true : undefined }) })
						}
					/>
				</FilterSidebarBody>
			</FilterSidebarFrame>
		))
		.render()

	const listSkeleton = (
		<div className="divide-y divide-border">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 py-2.5">
					<div className="flex-1 space-y-1.5">
						<Skeleton className="h-3.5 w-48" />
						<Skeleton className="h-3 w-64" />
					</div>
					<Skeleton className="hidden h-3.5 w-40 sm:block" />
				</div>
			))}
		</div>
	)

	const sessionsTable = Result.builder(sessionsResult)
		.onInitial(() => listSkeleton)
		.onError((error) => <QueryErrorState error={error} titleOverride="Failed to load agent sessions" />)
		.onSuccess(({ data }) =>
			data.length === 0 ? (
				<p className="py-8 text-center text-sm text-muted-foreground">
					No agent sessions in this window. Sessions appear when AI spans carry a
					session-granularity key.
				</p>
			) : (
				<table className="w-full text-xs">
					<thead>
						<tr className="border-b border-border text-left text-muted-foreground">
							<th className="py-2 pr-3 font-normal">Session</th>
							<th className="py-2 pr-3 font-normal">Vendors</th>
							<th className="py-2 pr-3 font-normal">Services</th>
							<th className="py-2 pr-3 text-right font-normal">Traces</th>
							<th className="py-2 pr-3 text-right font-normal">AI spans</th>
							<th className="py-2 pr-3 text-right font-normal">Errors</th>
							<th className="py-2 pr-3 text-right font-normal">Duration</th>
							<th className="py-2 font-normal">Last activity</th>
						</tr>
					</thead>
					<tbody>
						{data.map((row) => (
							<tr key={row.sessionKeyHash} className="border-b border-border/50">
								<td className="py-2 pr-3 font-mono">{row.sessionKeyHash.slice(0, 12)}…</td>
								<td className="py-2 pr-3">
									<VendorChips vendors={row.vendors} />
								</td>
								<td className="py-2 pr-3">{row.serviceNames.join(", ")}</td>
								<td className="py-2 pr-3 text-right tabular-nums">{row.traceCount}</td>
								<td className="py-2 pr-3 text-right tabular-nums">{row.keyedSpanCount}</td>
								<td className="py-2 pr-3 text-right tabular-nums">
									{row.errorCount > 0 ? (
										<span className="text-destructive">{row.errorCount}</span>
									) : (
										0
									)}
								</td>
								<td className="py-2 pr-3 text-right tabular-nums">{formatMs(row.durationMs)}</td>
								<td className="py-2 tabular-nums text-muted-foreground">
									{formatTime(row.endTime)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			),
		)
		.render()

	const tracesTable = Result.builder(tracesResult)
		.onInitial(() => listSkeleton)
		.onError((error) => <QueryErrorState error={error} titleOverride="Failed to load AI traces" />)
		.onSuccess(({ data }) =>
			data.length === 0 ? (
				<p className="py-8 text-center text-sm text-muted-foreground">
					No AI-classified traces in this window.
				</p>
			) : (
				<table className="w-full text-xs">
					<thead>
						<tr className="border-b border-border text-left text-muted-foreground">
							<th className="py-2 pr-3 font-normal">Trace</th>
							<th className="py-2 pr-3 font-normal">Vendors</th>
							<th className="py-2 pr-3 font-normal">Services</th>
							<th className="py-2 pr-3 font-normal">Session</th>
							<th className="py-2 pr-3 text-right font-normal">AI spans</th>
							<th className="py-2 pr-3 text-right font-normal">Errors</th>
							<th className="py-2 pr-3 text-right font-normal">AI window</th>
							<th className="py-2 font-normal">Start</th>
						</tr>
					</thead>
					<tbody>
						{data.map((row) => (
							<tr key={row.traceId} className="border-b border-border/50">
								<td className="max-w-64 truncate py-2 pr-3">
									<Link
										to="/traces/$traceId"
										params={{ traceId: row.traceId }}
										className="text-primary hover:underline"
									>
										{row.firstSpanName || row.traceId.slice(0, 16)}
									</Link>
								</td>
								<td className="py-2 pr-3">
									<VendorChips vendors={row.vendors} />
								</td>
								<td className="py-2 pr-3">{row.serviceNames.join(", ")}</td>
								<td className="py-2 pr-3 text-muted-foreground">
									{row.sessionKeyHash !== "" ? (
										<span className="font-mono">{row.sessionKeyHash.slice(0, 12)}…</span>
									) : (
										(KEY_STATE_LABELS[row.bestSessionKeyState] ?? "not examined")
									)}
								</td>
								<td className="py-2 pr-3 text-right tabular-nums">{row.aiSpanCount}</td>
								<td className="py-2 pr-3 text-right tabular-nums">
									{row.errorCount > 0 ? (
										<span className="text-destructive">{row.errorCount}</span>
									) : (
										0
									)}
								</td>
								<td className="py-2 pr-3 text-right tabular-nums">{formatMs(row.durationMs)}</td>
								<td className="py-2 tabular-nums text-muted-foreground">
									{formatTime(row.startTime)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			),
		)
		.render()

	const { startTime, endTime } = inputs

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "24h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[{ label: "Agent Sessions" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Filters>{sidebar}</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								title="Agent Sessions"
								description="AI agent activity across your services, grouped into sessions."
							>
								<TimeRangeHeaderControls
									startTime={search.startTime ?? startTime}
									endTime={search.endTime ?? endTime}
									presetValue={search.timePreset ?? (search.startTime ? undefined : "24h")}
									defaultPreset="24h"
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
							<div className="flex gap-1 border-b border-border pb-2">
								{(["sessions", "traces"] as const).map((t) => (
									<button
										key={t}
										type="button"
										className={`rounded-md px-3 py-1 text-xs ${
											tab === t
												? "bg-secondary font-medium text-foreground"
												: "text-muted-foreground hover:text-foreground"
										}`}
										onClick={() => navigate({ search: (prev) => ({ ...prev, tab: t }) })}
									>
										{t === "sessions" ? "Sessions" : "AI traces"}
									</button>
								))}
							</div>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							{tab === "sessions" ? sessionsTable : tracesTable}
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
