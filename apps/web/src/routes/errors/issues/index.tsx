import { useCallback, useMemo, useReducer, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import type { V2ErrorIssue } from "@maple/domain/http/v2"
import { toastManager } from "@maple/ui/components/ui/toast"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useListNavigation } from "@/hooks/use-list-navigation"
import { IssueGroup } from "@/components/errors/issue-group"
import { IssuesBulkBar } from "@/components/errors/issues-bulk-bar"
import { ListToolbar } from "@/components/common/list-toolbar"
import { severityRank } from "@/components/errors/severity-badge"
import { useIssueMutations } from "@/components/errors/use-issue-mutations"
import { IssueRow, type SelectToggleEvent } from "@/components/errors/issue-row"
import {
	clearedSelection,
	type IssueSelectionMsg,
	type IssueSelectionState,
	initialIssueSelection,
	toggledSelection,
	updateIssueSelection,
} from "@/lib/models/issue-selection"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { runMapleApiV2 } from "@/lib/collections/api-runner"
import {
	appendUniqueErrorIssues,
	buildErrorIssueListQuery,
	errorIssueFromV2,
	type ErrorIssueListQuery,
} from "@/lib/services/error-issues"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Button } from "@maple/ui/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { ErrorState } from "@/components/common/error-state"
import type { ErrorIssueDocument, ErrorIssueId, WorkflowState } from "@maple/domain/http"

const FILTER_VALUES = [
	"triage",
	"regressed",
	"todo",
	"in_progress",
	"in_review",
	"done",
	"cancelled",
	"wontfix",
	"all",
] as const

type FilterValue = (typeof FILTER_VALUES)[number]

const FILTER_LABEL: Record<FilterValue, string> = {
	triage: "Triage",
	regressed: "Regressed",
	todo: "Todo",
	in_progress: "In progress",
	in_review: "In review",
	done: "Done",
	cancelled: "Cancelled",
	wontfix: "Wontfix",
	all: "All",
} satisfies Record<FilterValue, string>

const TOOLBAR_TABS = FILTER_VALUES.map((value) => ({
	value,
	label: FILTER_LABEL[value],
}))

const GROUP_ORDER: ReadonlyArray<WorkflowState> = [
	// Regressions first: a fix that did not hold outranks an untriaged issue.
	"regressed",
	"triage",
	"todo",
	"in_progress",
	"in_review",
	"done",
	"cancelled",
	"wontfix",
]

const SEVERITY_FILTER_VALUES = ["all", "critical", "high", "medium", "low", "unset"] as const
type SeverityFilterValue = (typeof SEVERITY_FILTER_VALUES)[number]

const SEVERITY_FILTER_LABEL: Record<SeverityFilterValue, string> = {
	all: "All severities",
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	unset: "Unset",
} satisfies Record<SeverityFilterValue, string>

const searchSchema = Schema.Struct({
	// Derived from FILTER_VALUES rather than repeated: the hand-copied list drifted
	// the moment a new state was added.
	workflowState: Schema.optional(Schema.Literals(FILTER_VALUES)),
	severity: Schema.optional(Schema.Literals(SEVERITY_FILTER_VALUES)),
	kind: Schema.optional(Schema.Literals(["error", "alert"])),
})

export const Route = createFileRoute("/errors/issues/")({
	component: IssuesPage,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

/** The page chrome every phase renders: breadcrumbs + title + toolbar. */
function IssuesPageFrame({ toolbar, children }: { toolbar: React.ReactNode; children: React.ReactNode }) {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[{ label: "Errors", href: "/errors" }, { label: "Issues" }]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							title="Issues"
							description="Errors grouped into triage, in-progress, and resolved work."
						/>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div>
							{toolbar}
							{children}
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function IssuesSkeleton({ toolbar }: { toolbar: React.ReactNode }) {
	return (
		<IssuesPageFrame toolbar={toolbar}>
			<div className="space-y-px p-2">
				<Skeleton className="h-9 w-full" />
				<Skeleton className="h-9 w-full" />
				<Skeleton className="h-9 w-full" />
				<Skeleton className="h-9 w-full" />
				<Skeleton className="h-9 w-full" />
			</div>
		</IssuesPageFrame>
	)
}

function IssuesLoadError({
	toolbar,
	message,
	onRetry = () => window.location.reload(),
}: {
	toolbar: React.ReactNode
	message?: string
	onRetry?: () => void
}) {
	return (
		<IssuesPageFrame toolbar={toolbar}>
			<div className="p-4">
				<ErrorState
					error={message ?? "The issues stream could not be loaded."}
					title="Failed to load issues"
					onRetry={onRetry}
				/>
			</div>
		</IssuesPageFrame>
	)
}

function IssuesPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const activeFilter: FilterValue = search.workflowState ?? "triage"
	const severityFilter: SeverityFilterValue = search.severity ?? "all"
	const kindFilter = search.kind ?? "all"

	const listQuery = buildErrorIssueListQuery({
		workflowState: activeFilter,
		severity: severityFilter,
		kind: kindFilter,
	})
	const result = useAtomValue(
		retainedQueryV2("errorIssues", "list", {
			query: listQuery,
			reactivityKeys: ["errorIssues"],
		}),
	)
	const refresh = useAtomRefresh(
		retainedQueryV2("errorIssues", "list", {
			query: listQuery,
			reactivityKeys: ["errorIssues"],
		}),
	)

	const toolbar = (totalCount?: number) => (
		<ListToolbar
			tabs={TOOLBAR_TABS}
			active={activeFilter}
			label="Filter issues"
			countNoun={["issue", "issues"]}
			totalCount={totalCount}
			onChange={(value) => {
				navigate({
					search: (prev) => ({
						...prev,
						workflowState: value === "triage" ? undefined : value,
					}),
				})
			}}
			trailing={
				<>
					<Select
						value={kindFilter}
						onValueChange={(value) => {
							navigate({
								search: (prev) => ({
									...prev,
									kind: value === "all" ? undefined : (value as "error" | "alert"),
								}),
							})
						}}
					>
						<SelectTrigger size="sm" className="h-7 w-[110px] text-xs">
							<SelectValue placeholder="Kind" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All kinds</SelectItem>
							<SelectItem value="error">Errors</SelectItem>
							<SelectItem value="alert">Alerts</SelectItem>
						</SelectContent>
					</Select>
					<Select
						value={severityFilter}
						onValueChange={(value) => {
							navigate({
								search: (prev) => ({
									...prev,
									severity:
										value === "all"
											? undefined
											: (value as Exclude<SeverityFilterValue, "all">),
								}),
							})
						}}
					>
						<SelectTrigger size="sm" className="h-7 w-[120px] text-xs">
							<SelectValue placeholder="Severity" />
						</SelectTrigger>
						<SelectContent>
							{SEVERITY_FILTER_VALUES.map((value) => (
								<SelectItem key={value} value={value}>
									{SEVERITY_FILTER_LABEL[value]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</>
			}
		/>
	)

	if (Result.isInitial(result)) return <IssuesSkeleton toolbar={toolbar()} />
	if (Result.isFailure(result)) {
		return (
			<IssuesLoadError
				toolbar={toolbar()}
				message="The issues list could not be loaded."
				onRetry={refresh}
			/>
		)
	}

	return (
		<IssuesReadyBody
			key={`${activeFilter}:${severityFilter}:${kindFilter}`}
			initialPage={result.value}
			listQuery={listQuery}
			toolbar={toolbar}
			activeFilter={activeFilter}
		/>
	)
}

interface SelectionBinding {
	selection: IssueSelectionState
	dispatchSelection: (msg: IssueSelectionMsg) => void
}

const selectionReducer = (state: IssueSelectionState, message: IssueSelectionMsg): IssueSelectionState =>
	updateIssueSelection(state, message)[0]

interface IssuesReadyBodyProps {
	initialPage: {
		readonly data: ReadonlyArray<V2ErrorIssue>
		readonly next_cursor: string | null
		readonly has_more: boolean
	}
	listQuery: ErrorIssueListQuery
	toolbar: (totalCount?: number) => React.ReactNode
	activeFilter: FilterValue
}

function IssuesReadyBody({ initialPage, listQuery, activeFilter, toolbar }: IssuesReadyBodyProps) {
	const [selection, dispatchSelection] = useReducer(selectionReducer, initialIssueSelection)
	const [extraIssues, setExtraIssues] = useState<ReadonlyArray<ErrorIssueDocument>>([])
	const [nextCursorOverride, setNextCursorOverride] = useState<string | null | undefined>(undefined)
	const [loadingMore, setLoadingMore] = useState(false)
	const firstPageIssues = useMemo(() => initialPage.data.map(errorIssueFromV2), [initialPage.data])
	const issues = useMemo(
		() => appendUniqueErrorIssues(firstPageIssues, extraIssues),
		[firstPageIssues, extraIssues],
	)
	const nextCursor = nextCursorOverride === undefined ? initialPage.next_cursor : nextCursorOverride

	const resetLoadedPages = useCallback(() => {
		setExtraIssues([])
		setNextCursorOverride(undefined)
		dispatchSelection(clearedSelection)
	}, [])
	const mutations = useIssueMutations(resetLoadedPages)

	const loadMore = useCallback(async () => {
		if (nextCursor === null || loadingMore) return
		setLoadingMore(true)
		try {
			const page = await runMapleApiV2((client) =>
				client.errorIssues.list({ query: { ...listQuery, cursor: nextCursor } }),
			)
			setExtraIssues((current) => appendUniqueErrorIssues(current, page.data.map(errorIssueFromV2)))
			setNextCursorOverride(page.next_cursor)
		} catch {
			toastManager.add({ title: "More issues could not be loaded", type: "error" })
		} finally {
			setLoadingMore(false)
		}
	}, [listQuery, loadingMore, nextCursor])

	return (
		<IssuesPageBody
			issues={issues}
			activeFilter={activeFilter}
			toolbar={toolbar}
			mutations={mutations}
			selection={selection}
			dispatchSelection={dispatchSelection}
			hasMore={nextCursor !== null}
			loadingMore={loadingMore}
			onLoadMore={loadMore}
		/>
	)
}

interface IssuesPageBodyProps extends SelectionBinding {
	issues: ReadonlyArray<ErrorIssueDocument>
	activeFilter: FilterValue
	mutations: ReturnType<typeof useIssueMutations>
	toolbar: (totalCount?: number) => React.ReactNode
	hasMore: boolean
	loadingMore: boolean
	onLoadMore: () => void
}

function IssuesPageBody({
	issues,
	activeFilter,
	mutations,
	selection,
	dispatchSelection,
	toolbar,
	hasMore,
	loadingMore,
	onLoadMore,
}: IssuesPageBodyProps) {
	const selectedIds = selection.selectedIds
	const grouped = useMemo(() => {
		const map = new Map<WorkflowState, ErrorIssueDocument[]>()
		for (const issue of issues) {
			const bucket = map.get(issue.workflowState) ?? []
			bucket.push(issue)
			map.set(issue.workflowState, bucket)
		}
		for (const bucket of map.values()) {
			bucket.sort((a, b) => {
				const severityDiff = severityRank(a.severity) - severityRank(b.severity)
				if (severityDiff !== 0) return severityDiff
				if (a.priority !== b.priority) return a.priority - b.priority
				return b.lastSeenAt.localeCompare(a.lastSeenAt)
			})
		}
		return map
	}, [issues])

	const visibleGroups = useMemo(
		() => GROUP_ORDER.filter((state) => (grouped.get(state)?.length ?? 0) > 0),
		[grouped],
	)

	const flatIssues = useMemo<ReadonlyArray<ErrorIssueDocument>>(() => {
		const out: ErrorIssueDocument[] = []
		for (const state of visibleGroups) {
			const bucket = grouped.get(state)
			if (bucket) out.push(...bucket)
		}
		return out
	}, [grouped, visibleGroups])

	// The bulk bar needs each selected issue's current state, not just its id —
	// that is what lets it offer only the moves legal for the whole selection.
	const selectedIssues = useMemo(
		() =>
			flatIssues
				.filter((issue) => selectedIds.has(issue.id))
				.map((issue) => ({ id: issue.id, state: issue.workflowState })),
		[flatIssues, selectedIds],
	)

	const flatIssueIds = useMemo(() => flatIssues.map((i) => i.id as string), [flatIssues])

	// The shift-range/anchor logic now lives in the pure reducer
	// (updateIssueSelection); the row just reports the toggle + the current
	// visible order and the model figures out the rest.
	const toggleSelection = useCallback(
		(id: string, event: Pick<SelectToggleEvent, "shiftKey">) => {
			dispatchSelection(toggledSelection(id, event.shiftKey, flatIssueIds))
		},
		[dispatchSelection, flatIssueIds],
	)

	const clearSelection = useCallback(() => {
		dispatchSelection(clearedSelection)
	}, [dispatchSelection])

	const navigate = useNavigate({ from: Route.fullPath })

	const { focusedId, setFocusedId } = useListNavigation({
		ids: flatIssueIds,
		onOpen: (id) => {
			navigate({
				to: "/errors/issues/$issueId",
				params: { issueId: id as ErrorIssueId },
			})
		},
		onToggleSelect: toggleSelection,
		onEscape: () => {
			if (selectedIds.size === 0) return false
			clearSelection()
			return true
		},
		scrollTo: (id) => scrollIntoView(id),
	})

	const handleSelectToggle = useCallback(
		(id: string, event: SelectToggleEvent) => {
			toggleSelection(id, event)
			setFocusedId(id)
		},
		[toggleSelection, setFocusedId],
	)

	const handleFocus = useCallback(
		(id: string) => {
			setFocusedId(id)
		},
		[setFocusedId],
	)
	const showGroupHeaders = activeFilter === "all"

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[{ label: "Errors", href: "/errors" }, { label: "Issues" }]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							title="Issues"
							description="Errors grouped into triage, in-progress, and resolved work."
						/>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div>
							{toolbar(issues.length)}
							{issues.length === 0 ? (
								<div className="p-4">
									<Empty>
										<EmptyHeader>
											<EmptyTitle>No issues</EmptyTitle>
											<EmptyDescription>
												No issues match the {FILTER_LABEL[activeFilter].toLowerCase()}{" "}
												workflow and current severity/source filters.
											</EmptyDescription>
										</EmptyHeader>
									</Empty>
								</div>
							) : (
								<div>
									{showGroupHeaders ? (
										visibleGroups.map((state) => (
											<IssueGroup
												key={state}
												state={state}
												issues={grouped.get(state) ?? []}
												mutations={mutations}
												selectedIds={selectedIds}
												focusedId={focusedId}
												onSelectToggle={handleSelectToggle}
												onFocus={handleFocus}
											/>
										))
									) : (
										<div role="list" className="divide-y divide-border/40">
											{flatIssues.map((issue) => (
												<div role="listitem" key={issue.id}>
													<IssueRow
														issue={issue}
														mutations={mutations}
														selected={selectedIds.has(issue.id)}
														focused={focusedId === issue.id}
														onSelectToggle={handleSelectToggle}
														onFocus={handleFocus}
													/>
												</div>
											))}
										</div>
									)}
									{hasMore ? (
										<div className="flex justify-center border-t border-border/60 p-3">
											<Button
												type="button"
												variant="outline"
												size="sm"
												loading={loadingMore}
												onClick={onLoadMore}
											>
												Load more
											</Button>
										</div>
									) : null}
								</div>
							)}
						</div>
						<IssuesBulkBar
							selected={selectedIssues}
							mutations={mutations}
							onClear={clearSelection}
						/>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function scrollIntoView(issueId: string) {
	if (typeof document === "undefined") return
	const el = document.querySelector<HTMLElement>(`[data-issue-id="${CSS.escape(issueId)}"]`)
	if (!el) return
	el.scrollIntoView({ block: "nearest", behavior: "smooth" })
}
