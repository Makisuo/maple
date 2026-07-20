import { useCallback, useMemo, useReducer, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import type { V2ErrorIssue } from "@maple/domain/http/v2"
import { toast } from "sonner"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useListNavigation } from "@/hooks/use-list-navigation"
import { IssueGroup } from "@/components/errors/issue-group"
import { IssuesBulkBar } from "@/components/errors/issues-bulk-bar"
import { IssuesToolbar } from "@/components/errors/issues-toolbar"
import { severityRank } from "@/components/errors/severity-badge"
import { useIssueMutations } from "@/components/errors/use-issue-mutations"
import type { SelectToggleEvent } from "@/components/errors/issue-row"
import {
	clearedSelection,
	type IssueSelectionMsg,
	type IssueSelectionState,
	initialIssueSelection,
	toggledSelection,
	updateIssueSelection,
} from "@/lib/models/issue-selection"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
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
	todo: "Todo",
	in_progress: "In progress",
	in_review: "In review",
	done: "Done",
	cancelled: "Cancelled",
	wontfix: "Wontfix",
	all: "All",
}

const TOOLBAR_TABS = FILTER_VALUES.map((value) => ({
	value,
	label: FILTER_LABEL[value],
}))

const GROUP_ORDER: ReadonlyArray<WorkflowState> = [
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
}

const searchSchema = Schema.Struct({
	workflowState: Schema.optional(
		Schema.Literals([
			"all",
			"triage",
			"todo",
			"in_progress",
			"in_review",
			"done",
			"cancelled",
			"wontfix",
		]),
	),
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
		<DashboardLayout
			breadcrumbs={[{ label: "Errors", href: "/errors" }, { label: "Issues" }]}
			title="Issues"
			description="Errors grouped into triage, in-progress, and resolved work."
		>
			<div>
				{toolbar}
				{children}
			</div>
		</DashboardLayout>
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
		MapleApiV2AtomClient.query("errorIssues", "list", {
			query: listQuery,
			reactivityKeys: ["errorIssues"],
		}),
	)
	const refresh = useAtomRefresh(
		MapleApiV2AtomClient.query("errorIssues", "list", {
			query: listQuery,
			reactivityKeys: ["errorIssues"],
		}),
	)

	const toolbar = (totalCount?: number) => (
		<IssuesToolbar
			tabs={TOOLBAR_TABS}
			active={activeFilter}
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
			toast.error("More issues could not be loaded")
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

	const selectedArray = useMemo(
		() => flatIssues.filter((i) => selectedIds.has(i.id)).map((i) => i.id as ErrorIssueId),
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

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Errors", href: "/errors" }, { label: "Issues" }]}
			title="Issues"
			description="Errors grouped into triage, in-progress, and resolved work."
		>
			<div>
				{toolbar(issues.length)}
				{issues.length === 0 ? (
					<div className="p-4">
						<Empty>
							<EmptyHeader>
								<EmptyTitle>No issues</EmptyTitle>
								<EmptyDescription>
									{activeFilter === "triage"
										? "No issues in triage. Nice."
										: `No issues in state "${FILTER_LABEL[activeFilter]}".`}
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					</div>
				) : (
					<div>
						{visibleGroups.map((state) => (
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
						))}
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
			<IssuesBulkBar selectedIds={selectedArray} mutations={mutations} onClear={clearSelection} />
		</DashboardLayout>
	)
}

function scrollIntoView(issueId: string) {
	if (typeof document === "undefined") return
	const el = document.querySelector<HTMLElement>(`[data-issue-id="${CSS.escape(issueId)}"]`)
	if (!el) return
	el.scrollIntoView({ block: "nearest", behavior: "smooth" })
}
