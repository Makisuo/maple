import { useCallback, useMemo, useRef, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { Unitflow, View } from "@maple/unitflow/react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useListNavigation } from "@/hooks/use-list-navigation"
import { IssueGroup } from "@/components/errors/issue-group"
import { IssuesBulkBar } from "@/components/errors/issues-bulk-bar"
import { IssuesToolbar } from "@/components/errors/issues-toolbar"
import { severityRank } from "@/components/errors/severity-badge"
import { useIssueMutations } from "@/components/errors/use-issue-mutations"
import type { SelectToggleEvent } from "@/components/errors/issue-row"
import { ErrorIssuesModel, filterIssues } from "@/lib/models/error-issues-model"
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

	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
	const anchorRef = useRef<string | null>(null)

	const toolbar = (totalCount?: number) => (
		<IssuesToolbar
			tabs={TOOLBAR_TABS}
			active={activeFilter}
			totalCount={totalCount}
			onChange={(value) => {
				setSelectedIds(new Set())
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
							setSelectedIds(new Set())
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
							setSelectedIds(new Set())
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
					selectedIds={selectedIds}
					setSelectedIds={setSelectedIds}
					anchorRef={anchorRef}
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
	selectedIds: Set<string>
	setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>
	anchorRef: React.MutableRefObject<string | null>
}

const IssuesModelBody = View.make(ErrorIssuesModel, ({ overview }, props: IssuesBodyProps) => {
	if (overview.phase === "loading") return <IssuesSkeleton toolbar={props.toolbar()} />
	if (overview.phase === "error") {
		return <IssuesLoadError toolbar={props.toolbar()} message={overview.message} />
	}
	return <IssuesReadyBody allIssues={overview.issues} {...props} />
})

interface IssuesReadyBodyProps extends IssuesBodyProps {
	allIssues: ReadonlyArray<ErrorIssueDocument>
}

function IssuesReadyBody({ allIssues, activeFilter, severityFilter, kindFilter, ...props }: IssuesReadyBodyProps) {
	const issues = useMemo(
		() =>
			filterIssues(allIssues, {
				workflowState: activeFilter === "all" ? undefined : activeFilter,
				severity: severityFilter === "all" ? undefined : severityFilter,
				kind: kindFilter === "all" ? undefined : kindFilter,
			}),
		[allIssues, activeFilter, severityFilter, kindFilter],
	)

	return <IssuesPageBody issues={issues} activeFilter={activeFilter} {...props} />
}

interface IssuesPageBodyProps {
	issues: ReadonlyArray<ErrorIssueDocument>
	activeFilter: FilterValue
	mutations: ReturnType<typeof useIssueMutations>
	selectedIds: Set<string>
	setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>
	anchorRef: React.MutableRefObject<string | null>
	toolbar: (totalCount?: number) => React.ReactNode
}

function IssuesPageBody({
	issues,
	activeFilter,
	mutations,
	selectedIds,
	setSelectedIds,
	anchorRef,
	toolbar,
}: IssuesPageBodyProps) {
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

	const toggleSelection = useCallback(
		(id: string, event: Pick<SelectToggleEvent, "shiftKey">) => {
			setSelectedIds((prev) => {
				const next = new Set(prev)
				if (event.shiftKey && anchorRef.current) {
					const a = flatIssueIds.indexOf(anchorRef.current)
					const b = flatIssueIds.indexOf(id)
					if (a !== -1 && b !== -1) {
						const [lo, hi] = a < b ? [a, b] : [b, a]
						for (let i = lo; i <= hi; i++) next.add(flatIssueIds[i]!)
						return next
					}
				}
				if (next.has(id)) next.delete(id)
				else next.add(id)
				anchorRef.current = id
				return next
			})
		},
		[flatIssueIds, anchorRef, setSelectedIds],
	)

	const clearSelection = useCallback(() => {
		setSelectedIds(new Set())
	}, [setSelectedIds])

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
