import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { Exit } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import type { AlertDestinationDocument, AlertRuleDocument } from "@maple/domain/http"
import { Unitflow, View } from "@maple/unitflow/react"

import { AlertSegmentedSelect } from "@/components/alerts/alert-segmented-select"
import { AlertStatStrip } from "@/components/alerts/alert-stat-card"
import { AlertTagControls } from "@/components/alerts/alert-tag-controls"
import { ActiveIncidentsTable } from "@/components/alerts/overview/active-incidents-table"
import {
	AlertsHealthSummary,
	type AlertsStatusFilter,
} from "@/components/alerts/overview/alerts-health-summary"
import { RulesOverviewTable } from "@/components/alerts/overview/rules-overview-table"
import { BellIcon, CircleWarningIcon, MagnifierIcon, PlusIcon, XmarkIcon } from "@/components/icons"
import { getExitErrorMessage } from "@/lib/alerts/form-utils"
import { needsAttention } from "@/lib/alerts/rule-status"
import {
	filterByTags,
	groupByTag as groupItemsByTag,
	tagFacets,
	type TagGroup,
} from "@/lib/alerts/tag-grouping"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { AlertsOverviewModel, type AlertsOverviewReady } from "@/lib/models/alerts-overview-model"
import { unitflowRuntime } from "@/lib/models/runtime"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

/** Sentinel value for the "Created by" filter meaning no creator restriction. */
const ANY_CREATOR = "__anyone__"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The overview tab: health summary → active incidents (when firing) → filter
 * toolbar → per-rule status table → summary strip. The route only decides
 * which tab renders.
 *
 * Data + status derivation live in {@link AlertsOverviewModel} (unitflow),
 * fed by the Electric-synced collections; this component tree is pure
 * presentation over the model's `overview` store.
 */
export function AlertsOverviewTab() {
	return (
		<Unitflow
			runtime={unitflowRuntime}
			rootModel={AlertsOverviewModel}
			building={<OverviewSkeleton />}
			failed={() => <OverviewLoadError />}
		>
			{(unit) => <OverviewBody unit={unit} />}
		</Unitflow>
	)
}

function OverviewSkeleton() {
	return (
		<div className="space-y-6">
			<Skeleton className="h-[84px] w-full" />
			<Skeleton className="h-10 w-full" />
			<Skeleton className="h-48 w-full" />
		</div>
	)
}

function OverviewLoadError() {
	return (
		<Empty className="py-12">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<CircleWarningIcon size={18} />
				</EmptyMedia>
				<EmptyTitle>Failed to load alert rules</EmptyTitle>
				<EmptyDescription>Refresh the page or check your connection.</EmptyDescription>
			</EmptyHeader>
		</Empty>
	)
}

const OverviewBody = View.make(AlertsOverviewModel, ({ overview, toggleRule, toggleState }) => {
	if (overview.phase === "loading") return <OverviewSkeleton />
	if (overview.phase === "error") return <OverviewLoadError />
	return <AlertsOverviewContent data={overview} onToggleRule={toggleRule} toggleState={toggleState} />
})

/* ── Presentation ─────────────────────────────────────────────────────────── */

/**
 * Everything below is pure presentation over the derived overview: URL-backed
 * filters, search, the session/destination atoms, and the toggle mutation are
 * view concerns and stay here.
 */
function AlertsOverviewContent({
	data,
	onToggleRule,
	toggleState,
}: {
	data: AlertsOverviewReady
	/** The model's rule enable/disable Mutation, bound to a fire callback. */
	onToggleRule: (rule: AlertRuleDocument) => void
	/** The shared in-flight state of {@link onToggleRule}. */
	toggleState: AsyncResult.AsyncResult<AlertRuleDocument, unknown>
}) {
	const search = useSearch({ from: "/alerts/" })
	const navigate = useNavigate({ from: "/alerts/" })

	const {
		rules,
		incidents,
		openIncidents,
		statesByRule,
		incidentsByRule,
		derivedByRuleId,
		healthCounts,
		timelineRange,
	} = data

	const sessionResult = useAtomValue(MapleApiAtomClient.query("auth", "session", {}))
	const destinationsResult = useAtomValue(
		MapleApiAtomClient.query("alerts", "listDestinations", { reactivityKeys: ["alertDestinations"] }),
	)

	const destinations = Result.builder(destinationsResult)
		.onSuccess((response) => [...response.destinations] as AlertDestinationDocument[])
		.orElse(() => [])

	const isAdmin = Result.builder(sessionResult)
		.onSuccess((session) => session.roles.some((role) => role === "root" || role === "org:admin"))
		.orElse(() => false)
	const currentUserId = Result.builder(sessionResult)
		.onSuccess((session) => session.userId as string)
		.orElse(() => null)

	// Surface toggle failures as a toast by watching the shared mutation state
	// transition to a failure — an external side effect on a state change (the
	// no-useEffect "sync an external system" case). Success is silent: the
	// Electric `alertRules` shape re-renders the row on its own.
	const lastToggleState = useRef(toggleState)
	useEffect(() => {
		if (toggleState === lastToggleState.current) return
		lastToggleState.current = toggleState
		if (AsyncResult.isFailure(toggleState)) {
			toast.error(getExitErrorMessage(Exit.failCause(toggleState.cause), "Failed to update rule"))
		}
	}, [toggleState])
	const isToggling = AsyncResult.isWaiting(toggleState)

	const [searchQuery, setSearchQuery] = useState("")

	// Tag filter + grouping, URL-backed so views stay shareable.
	const selectedTags = useMemo(() => search.tags ?? [], [search.tags])
	const groupByTagOn = search.groupByTag ?? false
	const statusFilter = search.status
	const setSelectedTags = (tags: string[]) =>
		navigate({ search: (prev) => ({ ...prev, tags: tags.length > 0 ? tags : undefined }) })
	const setGroupByTagOn = (grouped: boolean) =>
		navigate({ search: (prev) => ({ ...prev, groupByTag: grouped ? true : undefined }) })
	const setStatusFilter = (status: AlertsStatusFilter | undefined) =>
		navigate({ search: (prev) => ({ ...prev, status }) })

	// "Created by" filter options — one entry per distinct rule creator, with the
	// current user surfaced as "You". Maple has no org-members endpoint, so other
	// creators are shown by their raw identifier.
	const creatorOptions = useMemo(() => {
		const options: Record<string, string> = { [ANY_CREATOR]: "Anyone" }
		for (const rule of rules) {
			if (!(rule.createdBy in options)) {
				options[rule.createdBy] = rule.createdBy === currentUserId ? "You" : rule.createdBy
			}
		}
		return options
	}, [rules, currentUserId])
	const creatorFilter = search.createdBy ?? ANY_CREATOR
	const showCreatorFilter = Object.keys(creatorOptions).length > 2

	/* ── Filtering ──────────────────────────────────────────────────────────── */

	const matchesStatusFilter = (rule: AlertRuleDocument): boolean => {
		if (statusFilter == null) return true
		const derived = derivedByRuleId.get(rule.id)
		if (derived == null) return false
		if (statusFilter === "attention") return needsAttention(derived)
		return derived.status === statusFilter
	}

	const filteredRules = useMemo(() => {
		let result: ReadonlyArray<AlertRuleDocument> = rules
		if (creatorFilter !== ANY_CREATOR) {
			result = result.filter((r) => r.createdBy === creatorFilter)
		}
		const q = searchQuery.trim().toLowerCase()
		if (q) {
			result = result.filter(
				(r) =>
					r.name.toLowerCase().includes(q) ||
					r.serviceNames?.some((s) => s.toLowerCase().includes(q)) ||
					r.tags.some((t) => t.includes(q)),
			)
		}
		result = result.filter(matchesStatusFilter)
		return [...filterByTags(result, (r) => r.tags, selectedTags)]
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rules, searchQuery, creatorFilter, selectedTags, statusFilter, derivedByRuleId])

	const ruleGroups: TagGroup<AlertRuleDocument>[] | null = useMemo(
		() => (groupByTagOn ? groupItemsByTag(filteredRules, (r) => r.tags) : null),
		[groupByTagOn, filteredRules],
	)

	const ruleTagFacets = useMemo(() => tagFacets(rules, (r) => r.tags), [rules])
	const tagsByRuleId = useMemo(
		() => new Map<string, readonly string[]>(rules.map((r) => [r.id, r.tags])),
		[rules],
	)
	const visibleIncidents = useMemo(
		() => [...filterByTags(openIncidents, (i) => tagsByRuleId.get(i.ruleId) ?? [], selectedTags)],
		[openIncidents, tagsByRuleId, selectedTags],
	)

	const destinationsById = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations])

	/* ── Summary strip (Triggered window + MTTR) ────────────────────────────── */

	const [triggeredWindow, setTriggeredWindow] = useState<"24h" | "7d" | "30d">("24h")
	const triggeredInWindow = useMemo(() => {
		const windowMs = triggeredWindow === "24h" ? DAY_MS : triggeredWindow === "7d" ? 7 * DAY_MS : 30 * DAY_MS
		const cutoff = Date.now() - windowMs
		return incidents.filter((i) => {
			if (!i.firstTriggeredAt) return false
			return new Date(i.firstTriggeredAt).getTime() >= cutoff
		}).length
	}, [incidents, triggeredWindow])

	const mttr = useMemo(() => {
		const resolved = incidents.filter((i) => i.resolvedAt && i.firstTriggeredAt)
		if (resolved.length === 0) return "—"
		const avg =
			resolved.reduce((sum, i) => {
				return sum + (new Date(i.resolvedAt!).getTime() - new Date(i.firstTriggeredAt).getTime())
			}, 0) / resolved.length
		if (avg < 60_000) return `${Math.round(avg / 1000)}s`
		if (avg < 3_600_000) return `${(avg / 60_000).toFixed(1)}m`
		return `${(avg / 3_600_000).toFixed(1)}h`
	}, [incidents])

	const enabledRules = rules.filter((r) => r.enabled).length

	/* ── Render ─────────────────────────────────────────────────────────────── */

	return (
		<div className="space-y-6">
			<AlertsHealthSummary counts={healthCounts} active={statusFilter} onActiveChange={setStatusFilter} />

			{visibleIncidents.length > 0 && (statusFilter == null || statusFilter === "firing") && (
				<ActiveIncidentsTable
					incidents={visibleIncidents}
					tagsByRuleId={tagsByRuleId}
					grouped={groupByTagOn}
				/>
			)}

			<div className="space-y-4">
				<div className="flex items-center gap-3">
					<InputGroup className="flex-1 max-w-xs">
						<InputGroupAddon>
							<MagnifierIcon />
						</InputGroupAddon>
						<InputGroupInput
							placeholder="Search rules..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
						/>
						{searchQuery && (
							<InputGroupAddon align="inline-end">
								<InputGroupButton aria-label="Clear search" onClick={() => setSearchQuery("")}>
									<XmarkIcon />
								</InputGroupButton>
							</InputGroupAddon>
						)}
					</InputGroup>
					{showCreatorFilter && (
						<Select
							items={creatorOptions}
							value={creatorFilter}
							onValueChange={(value) =>
								navigate({
									search: (prev) => ({
										...prev,
										createdBy: value === ANY_CREATOR ? undefined : (value as string),
									}),
								})
							}
						>
							<SelectTrigger className="w-[170px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(creatorOptions).map(([value, label]) => (
									<SelectItem key={value} value={value}>
										<span className="block max-w-[160px] truncate">{label}</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					<AlertTagControls
						facets={ruleTagFacets}
						selected={selectedTags}
						onSelectedChange={setSelectedTags}
						grouped={groupByTagOn}
						onGroupedChange={setGroupByTagOn}
					/>
				</div>

				{filteredRules.length === 0 && rules.length === 0 ? (
					<Empty className="py-12">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<BellIcon size={18} />
							</EmptyMedia>
							<EmptyTitle>No alert rules</EmptyTitle>
							<EmptyDescription>
								Create a threshold rule to open incidents for latency, error rate, throughput,
								Apdex, or exact metrics.
							</EmptyDescription>
						</EmptyHeader>
						{isAdmin && (
							<Button
								size="sm"
								render={<Link to="/alerts/create" search={{ serviceName: search.serviceName }} />}
							>
								<PlusIcon size={14} />
								Add rule
							</Button>
						)}
					</Empty>
				) : filteredRules.length === 0 ? (
					<Empty className="py-12">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<MagnifierIcon size={18} />
							</EmptyMedia>
							<EmptyTitle>No rules match your filters</EmptyTitle>
							<EmptyDescription>
								Try a different search term, creator, tag, or health filter.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<RulesOverviewTable
						rules={filteredRules}
						groups={ruleGroups}
						grouped={groupByTagOn}
						destinationsById={destinationsById}
						derivedByRuleId={derivedByRuleId}
						statesByRule={statesByRule}
						incidentsByRuleId={incidentsByRule}
						timelineRange={timelineRange}
						isAdmin={isAdmin}
						isToggling={isToggling}
						onToggle={onToggleRule}
					/>
				)}
			</div>

			{/* Slim summary strip — a secondary glance beneath the rules list */}
			<div className="space-y-2">
				<div className="flex justify-end">
					<AlertSegmentedSelect<"24h" | "7d" | "30d">
						options={[
							{ value: "24h", label: "24h" },
							{ value: "7d", label: "7d" },
							{ value: "30d", label: "30d" },
						]}
						value={triggeredWindow}
						onChange={setTriggeredWindow}
						size="sm"
						aria-label="Triggered window"
					/>
				</div>
				<AlertStatStrip
					items={[
						{
							label: `Triggered (${triggeredWindow})`,
							value: triggeredInWindow,
							hint: triggeredInWindow === 1 ? "incident" : "incidents",
						},
						{ label: "Avg MTTR", value: mttr, hint: "across resolved" },
						{ label: "Rules enabled", value: enabledRules, hint: `of ${rules.length} total` },
					]}
				/>
			</div>
		</div>
	)
}
