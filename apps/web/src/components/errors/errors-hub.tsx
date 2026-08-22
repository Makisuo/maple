import { useCallback, useMemo, useReducer } from "react"
import { useNavigate } from "@tanstack/react-router"

import type { ErrorIssueDocument, ErrorIssueId, WorkflowState } from "@maple/domain/http"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { cn } from "@maple/ui/lib/utils"
import { warehouseDateTimeToIso } from "@maple/query-engine"

import { ErrorState } from "@/components/common/error-state"
import { ListToolbar } from "@/components/common/list-toolbar"
import { useListNavigation } from "@/hooks/use-list-navigation"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	getErrorsByTypeResultAtom,
	getErrorsSparkResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { errorIssueFromV2 } from "@/lib/services/error-issues"
import {
	buildErrorSignals,
	indexInvestigationsByIssue,
	sparkFingerprintHashes,
	type ErrorSignal,
} from "@/lib/models/error-signal"
import {
	clearedSelection,
	type IssueSelectionMsg,
	type IssueSelectionState,
	initialIssueSelection,
	toggledSelection,
	updateIssueSelection,
} from "@/lib/models/issue-selection"

import { ErrorSignalHeader, ErrorSignalRow } from "./error-signal-row"
import { ErrorsStatStrip } from "./errors-stat-strip"
import { IssuesBulkBar } from "./issues-bulk-bar"
import { SEVERITY_FILL, SEVERITY_ORDER, SeverityDot, severityRank } from "./severity-badge"
import { useIssueMutations } from "./use-issue-mutations"

/**
 * The unified errors list.
 *
 * `/errors` grouped error events by fingerprint and knew nothing about triage;
 * `/errors/issues` listed the same fingerprints from Postgres and knew nothing
 * about volume; investigations sat on a third route. This joins them, so one
 * row answers the whole triage question. See `lib/models/error-signal.ts` for
 * why the fingerprint is the join key and why the issue table is the spine.
 */

/** How many buckets the row sparkline gets. Enough to show a shape, few enough
 *  that 50 of them stay cheap to render. */
const SPARK_BUCKETS = 32
const PAGE_LIMIT = 100

export const HUB_VIEWS = ["open", "triage", "active", "resolved", "all"] as const
export type HubView = (typeof HUB_VIEWS)[number]

const VIEW_LABEL: Record<HubView, string> = {
	open: "Open",
	triage: "Triage",
	active: "Active",
	resolved: "Resolved",
	all: "All",
} satisfies Record<HubView, string>

/**
 * Which workflow states each view covers. `triage` is the untouched queue,
 * `active` is everything someone has picked up, `resolved` is closed work.
 * `regressed` sits in triage because a fix that did not hold is untriaged
 * again, not in-progress.
 *
 * `open` is the union of triage and active, and it is `"all"` here because the
 * SERVER already narrows it: `actionable=true` maps to exactly
 * `ACTIONABLE_WORKFLOW_STATES` (triage, regressed, todo, in_progress,
 * in_review). That makes the default view a pure server query — worth having,
 * because every client-narrowed view fetches a page of actionable issues and
 * then discards part of it, so it can render far fewer rows than the page size
 * and paginate against a count that is not what you see.
 */
const VIEW_STATES = {
	open: "all",
	triage: ["triage", "regressed"],
	active: ["todo", "in_progress", "in_review"],
	resolved: ["done", "cancelled", "wontfix"],
	all: "all",
} satisfies Record<HubView, ReadonlyArray<WorkflowState> | "all">

/** Views the server can narrow with `actionable=true`, so the page it returns
 *  is already the right one. */
const ACTIONABLE_VIEWS: ReadonlyArray<HubView> = ["open", "triage", "active"]

/** Membership against the view's state set. The literal tuples above keep their
 *  inferred element types, which do not accept an arbitrary `WorkflowState` as
 *  an `includes` argument — widening happens here, once. */
function viewCovers(view: HubView, state: WorkflowState): boolean {
	const states: ReadonlyArray<string> | "all" = VIEW_STATES[view]
	return states === "all" || states.includes(state)
}

export const HUB_SORTS = ["volume", "severity", "last_seen"] as const
export type HubSort = (typeof HUB_SORTS)[number]

const SORT_LABEL: Record<HubSort, string> = {
	volume: "Most errors",
	severity: "Severity",
	last_seen: "Last seen",
} satisfies Record<HubSort, string>

export const SEVERITY_FILTERS = ["all", "critical", "high", "medium", "low", "unset"] as const
export type SeverityFilter = (typeof SEVERITY_FILTERS)[number]

const SEVERITY_FILTER_LABEL: Record<SeverityFilter, string> = {
	all: "All severities",
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	unset: "Unset",
} satisfies Record<SeverityFilter, string>

/**
 * What the closed trigger shows. Shorter than the menu labels because the
 * trigger has ~122px to work with and "All severities" truncated to
 * "All sever:" — and the stacked blob beside it already says "all of them", so
 * the word was doing no work. The menu keeps the long forms, where they read as
 * options rather than as a current state.
 */
const SEVERITY_TRIGGER_LABEL: Record<SeverityFilter, string> = {
	all: "Severity",
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	unset: "Unset",
} satisfies Record<SeverityFilter, string>

/** Base UI renders the raw value in the trigger unless it is given a renderer,
 *  and these guards are what let that renderer index the label maps. */
const isHubSort = (value: string | null): value is HubSort => HUB_SORTS.includes(value as HubSort)

const isSeverityFilter = (value: string | null): value is SeverityFilter =>
	SEVERITY_FILTERS.includes(value as SeverityFilter)

/**
 * The blob beside a severity option. "All severities" gets the four real levels
 * stacked into one mark rather than a fifth invented colour, so the menu shows
 * exactly the palette it filters on; "Unset" reuses the hollow ring.
 */
function SeverityFilterDot({ value }: { value: SeverityFilter }) {
	if (value === "all") {
		return (
			<span aria-hidden="true" className="flex shrink-0 -space-x-1">
				{SEVERITY_ORDER.map((severity) => (
					<span
						key={severity}
						className={cn("size-2 rounded-full ring-1 ring-popover", SEVERITY_FILL[severity])}
					/>
				))}
			</span>
		)
	}
	return <SeverityDot severity={value === "unset" ? null : value} />
}

export interface ErrorsHubProps {
	view: HubView
	sort: HubSort
	severity: SeverityFilter
	range: { startTime: string; endTime: string }
	services?: ReadonlyArray<string>
	deploymentEnvs?: ReadonlyArray<string>
	errorTypes?: ReadonlyArray<string>
	serviceVersions?: ReadonlyArray<string>
	rootOnly?: boolean
	showSpam?: boolean
}

const selectionReducer = (state: IssueSelectionState, message: IssueSelectionMsg): IssueSelectionState =>
	updateIssueSelection(state, message)[0]

export function ErrorsHub(props: ErrorsHubProps) {
	// Volume-ranked lists run warehouse-first: rank fingerprints by occurrences
	// in the window, then fetch exactly those issues. The other sorts run
	// issue-first, because Postgres already orders them and the warehouse only
	// knows about the window.
	const warehouseFilters = useMemo(
		() => ({
			startTime: props.range.startTime,
			endTime: props.range.endTime,
			services: props.services ? [...props.services] : undefined,
			deploymentEnvs: props.deploymentEnvs ? [...props.deploymentEnvs] : undefined,
			errorLabels: props.errorTypes ? [...props.errorTypes] : undefined,
			serviceVersions: props.serviceVersions ? [...props.serviceVersions] : undefined,
			showSpam: props.showSpam,
			rootOnly: props.rootOnly !== false,
			limit: PAGE_LIMIT,
		}),
		[
			props.range.startTime,
			props.range.endTime,
			props.services,
			props.deploymentEnvs,
			props.errorTypes,
			props.serviceVersions,
			props.showSpam,
			props.rootOnly,
		],
	)

	const volumeResult = useRefreshableAtomValue(getErrorsByTypeResultAtom({ data: warehouseFilters }))
	const volumeRows = Result.isSuccess(volumeResult) ? (volumeResult.value.data ?? []) : []

	const isVolumeSort = props.sort === "volume"

	/**
	 * The sidebar filters (service, environment, error type, version) are
	 * warehouse columns — Postgres has no idea which deploy an issue was seen on.
	 * The only way they can filter the ROWS, rather than just the ranking, is to
	 * resolve them to a fingerprint set here and ask for exactly those issues.
	 *
	 * So the list goes warehouse-first whenever a facet is active, and stays
	 * issue-first (Postgres orders, no cap) when nothing is filtered. The cost of
	 * warehouse-first is that the row set is capped to the window's top
	 * PAGE_LIMIT fingerprints by volume — which is also the URL budget, since
	 * these hashes travel as a query param.
	 */
	const hasFacetFilter =
		(props.services?.length ?? 0) > 0 ||
		(props.deploymentEnvs?.length ?? 0) > 0 ||
		(props.errorTypes?.length ?? 0) > 0 ||
		(props.serviceVersions?.length ?? 0) > 0
	const warehouseFirst = isVolumeSort || hasFacetFilter
	// Wait for the ranking before asking for issues, or the first render would
	// request an unfiltered page and then immediately discard it.
	const volumeReady = !warehouseFirst || Result.isSuccess(volumeResult)

	const listQuery = useMemo(() => {
		return {
			limit: PAGE_LIMIT,
			// The page's range is warehouse format ("YYYY-MM-DD HH:mm:ss"); the v2
			// contract takes ISO. Handing the raw range over fails to encode, and
			// the request never leaves the browser.
			start_time: warehouseDateTimeToIso(props.range.startTime),
			end_time: warehouseDateTimeToIso(props.range.endTime),
			sort: props.sort === "severity" ? ("severity" as const) : ("last_seen" as const),
			...(props.severity !== "all" ? { severity: props.severity } : undefined),
			// One state per request is all the API takes, so multi-state views are
			// filtered client-side from the window's page. `actionable` covers the
			// common triage+active case server-side so that page is the right one.
			...(ACTIONABLE_VIEWS.includes(props.view) ? { actionable: "true" as const } : undefined),
			...(warehouseFirst && volumeReady
				? { fingerprint_hash: volumeRows.map((row) => row.fingerprintHash).join(",") }
				: undefined),
		}
	}, [
		props.view,
		props.sort,
		props.severity,
		props.range.startTime,
		props.range.endTime,
		warehouseFirst,
		volumeReady,
		volumeRows,
	])

	const issuesResult = useAtomValue(
		retainedQueryV2("errorIssues", "list", {
			query: listQuery,
			reactivityKeys: ["errorIssues"],
		}),
	)

	const issues = useMemo<ReadonlyArray<ErrorIssueDocument>>(() => {
		if (!Result.isSuccess(issuesResult)) return []
		const all = issuesResult.value.data.map(errorIssueFromV2)
		return all.filter((issue) => viewCovers(props.view, issue.workflowState))
	}, [issuesResult, props.view])

	// The sparkline set follows the rows actually on screen, so a filtered view
	// never pays for fingerprints it will not draw.
	const fingerprintHashes = useMemo(() => sparkFingerprintHashes(issues), [issues])

	const bucketSeconds = useMemo(() => {
		const startMs = Date.parse(props.range.startTime.replace(" ", "T") + "Z")
		const endMs = Date.parse(props.range.endTime.replace(" ", "T") + "Z")
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 3600
		return Math.max(60, Math.round((endMs - startMs) / 1000 / SPARK_BUCKETS))
	}, [props.range.startTime, props.range.endTime])

	const sparkResult = useRefreshableAtomValue(
		getErrorsSparkResultAtom({
			data: {
				fingerprintHashes: [...fingerprintHashes],
				startTime: props.range.startTime,
				endTime: props.range.endTime,
				services: props.services ? [...props.services] : undefined,
				deploymentEnvs: props.deploymentEnvs ? [...props.deploymentEnvs] : undefined,
				errorLabels: props.errorTypes ? [...props.errorTypes] : undefined,
				serviceVersions: props.serviceVersions ? [...props.serviceVersions] : undefined,
				bucketSeconds,
			},
		}),
	)

	const investigationsResult = useAtomValue(
		retainedQueryV2("investigations", "list", {
			query: { limit: PAGE_LIMIT },
			reactivityKeys: ["investigations"],
		}),
	)

	const signals = useMemo(() => {
		const built = buildErrorSignals({
			issues,
			warehouse: volumeRows,
			spark: Result.isSuccess(sparkResult) ? (sparkResult.value.data ?? []) : [],
			investigations: indexInvestigationsByIssue(
				Result.isSuccess(investigationsResult) ? investigationsResult.value.data : [],
			),
		})
		return sortSignals(built, props.sort)
	}, [issues, volumeRows, sparkResult, investigationsResult, props.sort])

	const sparkWindow = useMemo(() => {
		const startMs = Date.parse(props.range.startTime.replace(" ", "T") + "Z")
		const endMs = Date.parse(props.range.endTime.replace(" ", "T") + "Z")
		return {
			startMs: Number.isFinite(startMs) ? startMs : 0,
			endMs: Number.isFinite(endMs) ? endMs : 0,
			bucketMs: bucketSeconds * 1000,
		}
	}, [props.range.startTime, props.range.endTime, bucketSeconds])

	const navigate = useNavigate()
	const setSearch = useCallback(
		(patch: Record<string, unknown>) => {
			navigate({ to: "/errors", search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) })
		},
		[navigate],
	)

	const toolbar = (
		<>
			<ErrorsStatStrip filters={warehouseFilters} />
			<ListToolbar
				tabs={HUB_VIEWS.map((value) => ({ value, label: VIEW_LABEL[value] }))}
				active={props.view}
				label="Filter errors"
				countNoun={["error", "errors"]}
				totalCount={signals.length}
				onChange={(value) => setSearch({ view: value === "open" ? undefined : value })}
				trailing={
					<>
						<Select
							value={props.sort}
							onValueChange={(value) =>
								setSearch({ sort: value === "volume" ? undefined : value })
							}
						>
							<SelectTrigger size="sm" className="h-7 w-[126px] text-xs">
								<SelectValue placeholder="Sort">
									{(value: string | null) =>
										isHubSort(value) ? SORT_LABEL[value] : "Sort"
									}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{HUB_SORTS.map((value) => (
									<SelectItem key={value} value={value}>
										{SORT_LABEL[value]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select
							value={props.severity}
							onValueChange={(value) =>
								setSearch({ severity: value === "all" ? undefined : value })
							}
						>
							<SelectTrigger size="sm" className="h-7 w-[122px] text-xs">
								<SelectValue placeholder="Severity">
									{(value: string | null) =>
										isSeverityFilter(value) ? (
											<span className="flex items-center gap-2">
												<SeverityFilterDot value={value} />
												{SEVERITY_TRIGGER_LABEL[value]}
											</span>
										) : (
											"Severity"
										)
									}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{SEVERITY_FILTERS.map((value) => (
									<SelectItem key={value} value={value}>
										<span className="flex items-center gap-2">
											<SeverityFilterDot value={value} />
											{SEVERITY_FILTER_LABEL[value]}
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</>
				}
			/>
		</>
	)

	if (Result.isInitial(issuesResult)) {
		return (
			<div>
				{toolbar}
				<div className="space-y-px p-2">
					{Array.from({ length: 6 }).map((_, index) => (
						<Skeleton key={index} className="h-11 w-full" />
					))}
				</div>
			</div>
		)
	}

	if (Result.isFailure(issuesResult)) {
		return (
			<div>
				{toolbar}
				<div className="p-4">
					<ErrorState
						error="The errors list could not be loaded."
						title="Failed to load errors"
						onRetry={() => window.location.reload()}
					/>
				</div>
			</div>
		)
	}

	return <HubList signals={signals} sparkWindow={sparkWindow} toolbar={toolbar} view={props.view} />
}

function sortSignals(signals: ReadonlyArray<ErrorSignal>, sort: HubSort): ReadonlyArray<ErrorSignal> {
	const sorted = [...signals]
	if (sort === "volume") {
		// Quiet fingerprints sink rather than sorting as zero among real counts.
		sorted.sort((a, b) => (b.windowCount ?? -1) - (a.windowCount ?? -1))
	} else if (sort === "severity") {
		sorted.sort((a, b) => {
			const diff = severityRank(a.severity) - severityRank(b.severity)
			return diff !== 0 ? diff : (b.windowCount ?? -1) - (a.windowCount ?? -1)
		})
	} else {
		sorted.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
	}
	return sorted
}

const EMPTY_COPY = {
	open: {
		title: "Nothing open",
		description:
			"Every error in this window is closed out. Widen the range, or check Resolved to see recent fixes.",
	},
	triage: {
		title: "Nothing waiting on triage",
		description: "Every error in this window has been picked up. Widen the range to see more.",
	},
	active: {
		title: "Nothing in progress",
		description: "No one has claimed an error in this window yet. Start from the triage queue.",
	},
	all: {
		title: "No errors in this window",
		description: "Nothing was recorded here. Widen the time range or clear the service filters.",
	},
	resolved: {
		title: "Nothing resolved yet",
		description: "Errors you close land here, so you can check whether a fix held.",
	},
} satisfies Record<HubView, { title: string; description: string }>

function HubList({
	signals,
	sparkWindow,
	toolbar,
	view,
}: {
	signals: ReadonlyArray<ErrorSignal>
	sparkWindow: { startMs: number; endMs: number; bucketMs: number }
	toolbar: React.ReactNode
	view: HubView
}) {
	const [selection, dispatchSelection] = useReducer(selectionReducer, initialIssueSelection)
	const selectedIds = selection.selectedIds
	const mutations = useIssueMutations(() => dispatchSelection(clearedSelection))
	const navigate = useNavigate()

	const ids = useMemo(() => signals.map((signal) => signal.id), [signals])

	const toggleSelection = useCallback(
		(id: ErrorIssueId, event: { shiftKey: boolean }) => {
			dispatchSelection(toggledSelection(id, event.shiftKey, ids))
		},
		[ids],
	)

	const clearSelection = useCallback(() => dispatchSelection(clearedSelection), [])

	const { focusedId, setFocusedId } = useListNavigation({
		ids,
		onOpen: (id) => navigate({ to: "/errors/issues/$issueId", params: { issueId: id } }),
		// Selection is keyboard-only now that rows carry no checkbox: "x" on the
		// focused row, shift+"x" to extend. Per-row actions moved to the right-click
		// menu, which is also where a single-row transition belongs.
		onToggleSelect: toggleSelection,
		onEscape: () => {
			if (selectedIds.size === 0) return false
			clearSelection()
			return true
		},
		scrollTo: (id) => scrollIntoView(id),
	})

	const selectedIssues = useMemo(
		() =>
			signals
				.filter((signal) => selectedIds.has(signal.id))
				.map((signal) => ({ id: signal.id, state: signal.issue.workflowState })),
		[signals, selectedIds],
	)

	const empty = EMPTY_COPY[view]

	return (
		<div>
			{toolbar}
			{signals.length === 0 ? (
				<div className="p-4">
					<Empty>
						<EmptyHeader>
							<EmptyTitle>{empty.title}</EmptyTitle>
							<EmptyDescription>{empty.description}</EmptyDescription>
						</EmptyHeader>
					</Empty>
				</div>
			) : (
				/* The header labels the columns; it is not one of the items, so it
				   sits outside the list rather than inside it. */
				<div>
					<ErrorSignalHeader />
					<div role="list" className="divide-y divide-border/40">
						{signals.map((signal) => (
							<div role="listitem" key={signal.id}>
								<ErrorSignalRow
									signal={signal}
									sparkWindow={sparkWindow}
									mutations={mutations}
									selected={selectedIds.has(signal.id)}
									focused={focusedId === signal.id}
									onFocus={setFocusedId}
								/>
							</div>
						))}
					</div>
				</div>
			)}
			<IssuesBulkBar selected={selectedIssues} mutations={mutations} onClear={clearSelection} />
		</div>
	)
}

function scrollIntoView(issueId: string) {
	if (typeof document === "undefined") return
	const el = document.querySelector<HTMLElement>(`[data-issue-id="${CSS.escape(issueId)}"]`)
	el?.scrollIntoView({ block: "nearest", behavior: "smooth" })
}
