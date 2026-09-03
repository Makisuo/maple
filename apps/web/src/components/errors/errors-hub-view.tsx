import { useCallback, useMemo, useReducer, useState } from "react"
import { useNavigate } from "@tanstack/react-router"

import type { ErrorIssueId, WorkflowState } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"

import { CircleCheckIcon, HistoryIcon, MagnifierIcon } from "@/components/icons"
import { ErrorState } from "@/components/common/error-state"
import { ListToolbar } from "@/components/common/list-toolbar"
import { useAppHotkey } from "@/hooks/use-app-hotkey"
import { useListNavigation } from "@/hooks/use-list-navigation"
import type { ErrorSignal } from "@/lib/models/error-signal"
import {
	clearedSelection,
	type IssueSelectionMsg,
	type IssueSelectionState,
	initialIssueSelection,
	toggledSelection,
	updateIssueSelection,
} from "@/lib/models/issue-selection"

import { ErrorSignalHeader, ErrorSignalRow, ErrorSignalRowSkeleton, type RowPicker } from "./error-signal-row"
import { IssuesBulkBar } from "./issues-bulk-bar"
import { SEVERITY_FILL, SEVERITY_ORDER, SeverityDot, severityRank } from "./severity-badge"
import { useIssueMutations } from "./use-issue-mutations"

/**
 * Everything the errors list renders, with none of what it fetches.
 *
 * `ErrorsHub` owns the warehouse-first/issue-first join and the URL; this owns
 * the toolbar, the column header, the rows, selection and the empty states. The
 * split is what `/lab/errors` renders over fixtures — a design pass on the list
 * happens here, and the real page inherits it, rather than being eyeballed
 * against whatever the dev org happens to be erroring on today.
 */

/** Enough to fill the fold without pretending to know the page size. */
const SKELETON_ROWS = 8

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
 * `open` is the union of triage and active, spelled out rather than left as
 * `"all"`. The SERVER already narrows it — `actionable=true` maps to exactly
 * these five states — so on the real page the client filter passes every row it
 * is given and discards nothing. Spelling it out is what lets the view be
 * rendered off a fixture (`/lab/errors`) and still show the set the server
 * would have returned.
 */
const VIEW_STATES = {
	open: ["triage", "regressed", "todo", "in_progress", "in_review"],
	triage: ["triage", "regressed"],
	active: ["todo", "in_progress", "in_review"],
	resolved: ["done", "cancelled", "wontfix"],
	all: "all",
} satisfies Record<HubView, ReadonlyArray<WorkflowState> | "all">

/** Views the server can narrow with `actionable=true`, so the page it returns
 *  is already the right one. */
export const ACTIONABLE_VIEWS: ReadonlyArray<HubView> = ["open", "triage", "active"]

/** Membership against the view's state set. The literal tuples above keep their
 *  inferred element types, which do not accept an arbitrary `WorkflowState` as
 *  an `includes` argument — widening happens here, once. */
export function viewCovers(view: HubView, state: WorkflowState): boolean {
	const states: ReadonlyArray<string> | "all" = VIEW_STATES[view]
	return states === "all" || states.includes(state)
}

/** `last_seen` leads because it is the default: newest activity first, paged
 *  back through older issues. `volume` is the one sort only the warehouse can
 *  answer, so it is the one scoped to the time range. */
export const HUB_SORTS = ["last_seen", "volume", "severity"] as const
export type HubSort = (typeof HUB_SORTS)[number]

const SORT_LABEL: Record<HubSort, string> = {
	last_seen: "Most recent",
	volume: "Most errors",
	severity: "Severity",
} satisfies Record<HubSort, string>

/**
 * Where the list stands relative to the pages it has not shown yet. `more`
 * offers the button, `loading` swaps it for placeholder rows, `failed` turns
 * it into a retry, `end` draws nothing — the last page is the last page.
 */
export interface HubPaging {
	readonly state: "more" | "loading" | "failed" | "end"
	readonly onLoadMore: () => void
}

/** Placeholder rows under the list while the next page loads. Fewer than the
 *  first paint's, because the reader already has rows to look at. */
const LOAD_MORE_SKELETON_ROWS = 3

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

export function sortSignals(signals: ReadonlyArray<ErrorSignal>, sort: HubSort): ReadonlyArray<ErrorSignal> {
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

/**
 * What an empty view says, and what it offers to do about it.
 *
 * Most of these are good news — an empty Open queue means the errors are all
 * closed out — so they read as an all-clear rather than as a failure, and the
 * icon carries that before the sentence does. The exception is a view emptied
 * by a filter the reader chose, which is not news at all: that gets the
 * magnifier and a button that undoes the filter, because an empty list whose
 * cause is one control away should not be a dead end.
 */
const EMPTY_COPY = {
	open: {
		icon: CircleCheckIcon,
		title: "Nothing open",
		description: "Every error here is closed out. Check Resolved to see recent fixes.",
	},
	triage: {
		icon: CircleCheckIcon,
		title: "Nothing waiting on triage",
		description: "Every error here has been picked up.",
	},
	active: {
		icon: CircleCheckIcon,
		title: "Nothing in progress",
		description: "No one has claimed an error yet. Start from the triage queue.",
	},
	all: {
		icon: CircleCheckIcon,
		title: "No errors here",
		description: "Nothing has been recorded. If a filter is on, clearing it shows everything.",
	},
	resolved: {
		icon: HistoryIcon,
		title: "Nothing resolved yet",
		description: "Errors you close land here, so you can check whether a fix held.",
	},
} satisfies Record<HubView, { icon: typeof CircleCheckIcon; title: string; description: string }>

export interface ErrorsHubViewProps {
	/** `loading` draws row skeletons, `failed` the retry card. Both keep the
	 *  toolbar, so the controls never move between states. */
	status: "loading" | "failed" | "ready"
	/** Unsorted; the view applies `sort` itself so the lab and the page cannot
	 *  disagree about what "Most errors" means. */
	signals: ReadonlyArray<ErrorSignal>
	sparkWindow: { readonly startMs: number; readonly endMs: number; readonly bucketMs: number }
	view: HubView
	sort: HubSort
	severity: SeverityFilter
	onViewChange: (view: HubView) => void
	onSortChange: (sort: HubSort) => void
	onSeverityChange: (severity: SeverityFilter) => void
	/** The window totals above the toolbar. A slot rather than a component
	 *  because it is the one part of the list that fetches for itself. */
	stats?: React.ReactNode
	/** Omitted when the list is complete as given — the lab, or a fixture. */
	paging?: HubPaging
	/** Present while a sidebar filter is on: the empty state offers to clear it. */
	onClearFilters?: () => void
	onRetry: () => void
}

export function ErrorsHubView({
	status,
	signals,
	sparkWindow,
	view,
	sort,
	severity,
	onViewChange,
	onSortChange,
	onSeverityChange,
	stats,
	paging,
	onClearFilters,
	onRetry,
}: ErrorsHubViewProps) {
	const sorted = useMemo(() => sortSignals(signals, sort), [signals, sort])

	// A paged list cannot state a total. "50+" says what is known — at least this
	// many — without pretending the next page is empty.
	const hasUnshownPages = paging !== undefined && paging.state !== "end"

	const toolbar = (
		<>
			{stats}
			<ListToolbar
				tabs={HUB_VIEWS.map((value) => ({ value, label: VIEW_LABEL[value] }))}
				active={view}
				label="Filter errors"
				countNoun={["error", "errors"]}
				/* No count until there is one to state. "0 errors" under a spinner is
				   a claim about the data, and it is wrong every time. */
				totalCount={status === "ready" ? sorted.length : undefined}
				countLabel={status === "ready" && hasUnshownPages ? `${sorted.length}+ errors` : undefined}
				onChange={onViewChange}
				trailing={
					<>
						<Select
							value={sort}
							onValueChange={(value) => {
								if (isHubSort(value)) onSortChange(value)
							}}
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
							value={severity}
							onValueChange={(value) => {
								if (isSeverityFilter(value)) onSeverityChange(value)
							}}
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

	if (status === "loading") {
		return (
			<div>
				{toolbar}
				{/* The real column header, not a placeholder for it: it is already
				    known, it explains what is loading, and keeping it means the rows
				    land in the columns the eye is already resting on. */}
				<ErrorSignalHeader />
				<div className="divide-y divide-border/40">
					{Array.from({ length: SKELETON_ROWS }).map((_, index) => (
						<ErrorSignalRowSkeleton key={index} index={index} />
					))}
				</div>
			</div>
		)
	}

	if (status === "failed") {
		return (
			<div>
				{toolbar}
				<div className="p-4">
					<ErrorState
						error="The errors list could not be loaded."
						title="Failed to load errors"
						onRetry={onRetry}
					/>
				</div>
			</div>
		)
	}

	return (
		<HubList
			signals={sorted}
			sparkWindow={sparkWindow}
			toolbar={toolbar}
			view={view}
			severity={severity}
			onViewChange={onViewChange}
			onSeverityChange={onSeverityChange}
			paging={paging}
			onClearFilters={onClearFilters}
		/>
	)
}

const selectionReducer = (state: IssueSelectionState, message: IssueSelectionMsg): IssueSelectionState =>
	updateIssueSelection(state, message)[0]

function HubList({
	signals,
	sparkWindow,
	toolbar,
	view,
	severity,
	onViewChange,
	onSeverityChange,
	paging,
	onClearFilters,
}: {
	signals: ReadonlyArray<ErrorSignal>
	sparkWindow: { startMs: number; endMs: number; bucketMs: number }
	toolbar: React.ReactNode
	view: HubView
	severity: SeverityFilter
	onViewChange: (view: HubView) => void
	onSeverityChange: (severity: SeverityFilter) => void
	paging: HubPaging | undefined
	onClearFilters: (() => void) | undefined
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

	// One picker open across the whole list. Linear's "s" and "p": the focused
	// row opens its status or severity picker without a pointer reaching the
	// button — which may not even be on screen at narrow widths, hence the
	// row's fallback anchor.
	const [openPicker, setOpenPicker] = useState<{ id: ErrorIssueId; kind: RowPicker } | null>(null)
	const openPickerOnFocused = (kind: RowPicker) => {
		if (focusedId !== null) setOpenPicker({ id: focusedId, kind })
	}
	useAppHotkey("issue.status", () => openPickerOnFocused("state"))
	useAppHotkey("issue.severity", () => openPickerOnFocused("severity"))

	const selectedIssues = useMemo(
		() =>
			signals
				.filter((signal) => selectedIds.has(signal.id))
				.map((signal) => ({ id: signal.id, state: signal.issue.workflowState })),
		[signals, selectedIds],
	)

	return (
		<div>
			{toolbar}
			{signals.length === 0 ? (
				<HubEmpty
					view={view}
					severity={severity}
					onViewChange={onViewChange}
					onSeverityChange={onSeverityChange}
					onClearFilters={onClearFilters}
				/>
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
									picker={openPicker?.id === signal.id ? openPicker.kind : null}
									onPickerChange={(kind) =>
										setOpenPicker(kind === null ? null : { id: signal.id, kind })
									}
								/>
							</div>
						))}
					</div>
					{paging !== undefined ? <HubPagingFooter paging={paging} /> : null}
				</div>
			)}
			<IssuesBulkBar selected={selectedIssues} mutations={mutations} onClear={clearSelection} />
		</div>
	)
}

function HubEmpty({
	view,
	severity,
	onViewChange,
	onSeverityChange,
	onClearFilters,
}: {
	view: HubView
	severity: SeverityFilter
	onViewChange: (view: HubView) => void
	onSeverityChange: (severity: SeverityFilter) => void
	onClearFilters: (() => void) | undefined
}) {
	const empty = EMPTY_COPY[view]
	// A severity filter is the one narrowing the reader can see in the toolbar
	// and undo from here, so an empty list under one is its own state rather
	// than the view's all-clear.
	const filtered = severity !== "all"
	// Likewise a sidebar filter: an all-clear under one would be a claim about
	// errors the filter is hiding.
	const narrowed = filtered || onClearFilters !== undefined
	const Icon = narrowed ? MagnifierIcon : empty.icon

	return (
		<Empty className="py-12">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Icon size={18} />
				</EmptyMedia>
				<EmptyTitle>
					{filtered
						? `No ${SEVERITY_FILTER_LABEL[severity].toLowerCase()} errors here`
						: narrowed
							? "Nothing matches these filters"
							: empty.title}
				</EmptyTitle>
				<EmptyDescription>
					{filtered
						? `Nothing in ${VIEW_LABEL[view]} matches that severity. Other severities may have plenty.`
						: narrowed
							? `No ${VIEW_LABEL[view].toLowerCase()} errors match the sidebar filters. Clear them to see everything.`
							: empty.description}
				</EmptyDescription>
			</EmptyHeader>
			{filtered || onClearFilters !== undefined || view !== "all" ? (
				<div className="flex flex-wrap items-center justify-center gap-2">
					{filtered ? (
						<Button size="sm" variant="outline" onClick={() => onSeverityChange("all")}>
							Show all severities
						</Button>
					) : null}
					{/* A sidebar filter is the other narrowing the reader chose, and the
					    sidebar may be collapsed — so the way out is offered here too. */}
					{onClearFilters !== undefined ? (
						<Button size="sm" variant={filtered ? "ghost" : "outline"} onClick={onClearFilters}>
							Clear filters
						</Button>
					) : null}
					{view !== "all" ? (
						<Button
							size="sm"
							variant={filtered || onClearFilters !== undefined ? "ghost" : "outline"}
							onClick={() => onViewChange("all")}
						>
							See every error
						</Button>
					) : null}
				</div>
			) : null}
		</Empty>
	)
}

/**
 * The bottom of a page that is not the bottom of the list.
 *
 * Loading draws placeholder rows in the list's own grid rather than a spinner
 * under a button, so the next page lands where the eye already is. A failed
 * page says so in place: the rows above it are fine, and a toast would leave
 * nothing here to retry from.
 */
function HubPagingFooter({ paging }: { paging: HubPaging }) {
	if (paging.state === "end") return null

	if (paging.state === "loading") {
		return (
			<div className="divide-y divide-border/40 border-t border-border/40" aria-busy="true">
				{Array.from({ length: LOAD_MORE_SKELETON_ROWS }).map((_, index) => (
					<ErrorSignalRowSkeleton key={index} index={index} />
				))}
			</div>
		)
	}

	return (
		<div className="flex items-center justify-center gap-3 border-t border-border/40 p-4">
			{paging.state === "failed" ? (
				<span className="text-xs text-muted-foreground">More errors could not be loaded.</span>
			) : null}
			<Button variant="outline" size="sm" onClick={paging.onLoadMore}>
				{paging.state === "failed" ? "Retry" : "Load more"}
			</Button>
		</div>
	)
}

function scrollIntoView(issueId: string) {
	if (typeof document === "undefined") return
	const el = document.querySelector<HTMLElement>(`[data-issue-id="${CSS.escape(issueId)}"]`)
	el?.scrollIntoView({ block: "nearest", behavior: "smooth" })
}
