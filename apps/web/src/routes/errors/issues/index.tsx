import { useCallback, useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { Unitflow, View } from "@maple/unitflow/react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useListNavigation } from "@/hooks/use-list-navigation"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { IssueGroup } from "@/components/errors/issue-group"
import { IssuesBulkBar } from "@/components/errors/issues-bulk-bar"
import { IssuesToolbar } from "@/components/errors/issues-toolbar"
import { severityRank } from "@/components/errors/severity-badge"
import { useIssueMutations } from "@/components/errors/use-issue-mutations"
import type { SelectToggleEvent } from "@/components/errors/issue-row"
import { ErrorIssuesModel, filterIssues } from "@/lib/models/error-issues-model"
import {
	clearedSelection,
	type IssueSelectionMsg,
	type IssueSelectionState,
	toggledSelection,
} from "@/lib/models/issue-selection"
import { unitflowRuntime } from "@/lib/models/runtime"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
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

export const Route = effectRoute(createFileRoute("/errors/issues/"))({
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

function IssuesLoadError({ toolbar, message }: { toolbar: React.ReactNode; message?: string }) {
	return (
		<IssuesPageFrame toolbar={toolbar}>
			<div className="p-4">
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Failed to load issues</EmptyTitle>
						<EmptyDescription>{message ?? "Try refreshing or check API logs."}</EmptyDescription>
					</EmptyHeader>
				</Empty>
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

	const mutations = useIssueMutations()

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

	return (
		<Unitflow
			runtime={unitflowRuntime}
			rootModel={ErrorIssuesModel}
			building={<IssuesSkeleton toolbar={toolbar()} />}
			failed={() => <IssuesLoadError toolbar={toolbar()} />}
		>
			{(unit) => (
				<IssuesModelBody
					unit={unit}
					toolbar={toolbar}
					activeFilter={activeFilter}
					severityFilter={severityFilter}
					kindFilter={kindFilter}
					mutations={mutations}
				/>
			)}
		</Unitflow>
	)
}

interface IssuesBodyProps {
	toolbar: (totalCount?: number) => React.ReactNode
	activeFilter: FilterValue
	severityFilter: SeverityFilterValue
	kindFilter: "all" | "error" | "alert"
	mutations: ReturnType<typeof useIssueMutations>
}

/** The model-owned selection state + its dispatcher, bound from the model's
 * `ui` and threaded down to the rows and the bulk bar. */
interface SelectionBinding {
	selection: IssueSelectionState
	dispatchSelection: (msg: IssueSelectionMsg) => void
}

const IssuesModelBody = View.make(
	ErrorIssuesModel,
	({ overview, selection, dispatchSelection }, props: IssuesBodyProps) => {
		if (overview.phase === "loading") return <IssuesSkeleton toolbar={props.toolbar()} />
		if (overview.phase === "error") {
			return <IssuesLoadError toolbar={props.toolbar()} message={overview.message} />
		}
		return (
			<IssuesReadyBody
				allIssues={overview.issues}
				selection={selection}
				dispatchSelection={dispatchSelection}
				{...props}
			/>
		)
	},
)

/** Resets the model-owned selection on page entry and whenever the URL filters
 * change. The filters live above the `<Unitflow>` provider, so rather than an
 * effect that watches them, this null component is remounted by its `key` (and
 * on a fresh page mount, since the whole subtree unmounts on navigation away)
 * and fires `Cleared` — the sanctioned no-useEffect "re-run via key" pattern.
 * `hasSelection` gates the dispatch so the common empty-selection case (first
 * load, or a filter change with nothing selected) doesn't emit a no-op. */
function ClearSelectionOnFilterChange({
	dispatchSelection,
	hasSelection,
}: {
	dispatchSelection: (msg: IssueSelectionMsg) => void
	hasSelection: boolean
}) {
	useMountEffect(() => {
		if (hasSelection) dispatchSelection(clearedSelection)
	})
	return null
}

interface IssuesReadyBodyProps extends IssuesBodyProps, SelectionBinding {
	allIssues: ReadonlyArray<ErrorIssueDocument>
}

function IssuesReadyBody({
	allIssues,
	activeFilter,
	severityFilter,
	kindFilter,
	...props
}: IssuesReadyBodyProps) {
	const issues = useMemo(
		() =>
			filterIssues(allIssues, {
				workflowState: activeFilter === "all" ? undefined : activeFilter,
				severity: severityFilter === "all" ? undefined : severityFilter,
				kind: kindFilter === "all" ? undefined : kindFilter,
			}),
		[allIssues, activeFilter, severityFilter, kindFilter],
	)

	return (
		<>
			<ClearSelectionOnFilterChange
				key={`${activeFilter}:${severityFilter}:${kindFilter}`}
				dispatchSelection={props.dispatchSelection}
				hasSelection={props.selection.selectedIds.size > 0}
			/>
			<IssuesPageBody issues={issues} activeFilter={activeFilter} {...props} />
		</>
	)
}

interface IssuesPageBodyProps extends SelectionBinding {
	issues: ReadonlyArray<ErrorIssueDocument>
	activeFilter: FilterValue
	mutations: ReturnType<typeof useIssueMutations>
	toolbar: (totalCount?: number) => React.ReactNode
}

function IssuesPageBody({
	issues,
	activeFilter,
	mutations,
	selection,
	dispatchSelection,
	toolbar,
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
