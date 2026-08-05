import { useMemo, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Exit, Schema } from "effect"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@maple/ui/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { ToolbarSearch } from "@maple/ui/components/toolbar"
import { toastManager } from "@maple/ui/components/ui/toast"

import { ErrorState } from "@/components/common/error-state"
import { ListToolbar } from "@/components/common/list-toolbar"
import { ChatBubbleSparkleIcon } from "@/components/icons"
import {
	investigationKindKey,
	matchesQuery,
	sortInvestigations,
	type InvestigationKindKey,
	type InvestigationSortKey,
} from "@/components/investigations/investigation-display"
import {
	InvestigationTable,
	InvestigationTableSkeleton,
} from "@/components/investigations/investigation-table"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

type HubView = "active" | "history"

const searchSchema = Schema.Struct({
	view: Schema.optional(Schema.Literals(["active", "history"])),
	kind: Schema.optional(Schema.Literals(["alert", "error", "anomaly", "question"])),
	sort: Schema.optional(Schema.Literals(["updated", "severity", "confidence"])),
	dir: Schema.optional(Schema.Literals(["asc", "desc"])),
	q: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/investigations/")({
	component: InvestigationsHub,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

const PAGE_SIZE = 100

const ACTIVE_STATUSES: ReadonlyArray<V2Investigation["status"]> = ["investigating", "diagnosed"]

const isActive = (investigation: V2Investigation) => ACTIVE_STATUSES.includes(investigation.status)

/**
 * `all` is a filter value, not a kind — it only exists so the trigger has
 * something to show when nothing is filtered.
 */
const KIND_FILTER_LABEL: Record<InvestigationKindKey | "all", string> = {
	all: "All kinds",
	alert: "Alerts",
	error: "Errors",
	anomaly: "Anomalies",
	question: "Questions",
}

const KIND_FILTER_VALUES = Object.keys(KIND_FILTER_LABEL) as ReadonlyArray<InvestigationKindKey | "all">

const kindFilterLabel = (value: unknown): string =>
	typeof value === "string" && value in KIND_FILTER_LABEL
		? KIND_FILTER_LABEL[value as InvestigationKindKey | "all"]
		: KIND_FILTER_LABEL.all

function InvestigationsHub() {
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()
	const view: HubView = search.view ?? "active"
	const sortKey: InvestigationSortKey = search.sort ?? "updated"
	const sortDirection = search.dir ?? "desc"
	const query = search.q ?? ""
	const isFiltered = query.trim().length > 0 || search.kind !== undefined

	const [subject, setSubject] = useState("")
	const [creating, setCreating] = useState(false)
	const listQuery = MapleApiV2AtomClient.query("investigations", "list", {
		query: { limit: PAGE_SIZE },
		reactivityKeys: ["investigations"],
	})
	const result = useAtomValue(listQuery)
	const refresh = useAtomRefresh(listQuery)
	const create = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "create"), {
		mode: "promiseExit",
	})

	const page = Result.builder(result)
		.onSuccess((response) => response.data)
		.orElse((): ReadonlyArray<V2Investigation> => [])
	const hasMore = Result.builder(result)
		.onSuccess((response) => response.has_more)
		.orElse(() => false)

	// The list endpoint filters by a single status, but each tab spans two, so the
	// split happens here — which is also what lets the tabs carry counts.
	const activeCount = useMemo(() => page.filter(isActive).length, [page])
	const investigations = useMemo(() => {
		const inView = page.filter((investigation) =>
			view === "active" ? isActive(investigation) : !isActive(investigation),
		)
		const filtered = inView.filter(
			(investigation) =>
				(search.kind === undefined || investigationKindKey(investigation.subject) === search.kind) &&
				matchesQuery(investigation, query),
		)
		return sortInvestigations(filtered, sortKey, sortDirection)
	}, [page, view, search.kind, query, sortKey, sortDirection])

	const handleSort = (key: InvestigationSortKey) => {
		void navigate({
			search: (prev) => ({
				...prev,
				sort: key === "updated" ? undefined : key,
				// A first click on a column means "most of this first"; clicking the
				// active column flips it.
				dir: key === sortKey && sortDirection === "desc" ? "asc" : undefined,
			}),
		})
	}

	const handleCreate = async () => {
		const title = subject.trim()
		if (!title) return
		setCreating(true)
		const created = await create({
			payload: {
				subject: { type: "freeform", title, prompt: title, context_refs: [] },
				snapshot: {
					title,
					scope: null,
					status: "open",
					severity: null,
					facts: [],
					references: [],
					incidentStartedAt: null,
					incidentEndedAt: null,
				},
			},
			reactivityKeys: ["investigations"],
		})
		setCreating(false)
		if (Exit.isSuccess(created)) {
			setSubject("")
			void navigate({ to: "/investigations/$id", params: { id: created.value.id } })
		} else {
			toastManager.add({ title: "Investigation could not be started", type: "error" })
		}
	}

	const toolbar = (
		<ListToolbar
			tabs={[
				{ value: "active", label: "Active", count: activeCount },
				{ value: "history", label: "History", count: page.length - activeCount },
			]}
			active={view}
			label="Filter investigations"
			onChange={(value) =>
				void navigate({
					search: (prev) => ({ ...prev, view: value === "active" ? undefined : value }),
				})
			}
			countNoun={["investigation", "investigations"]}
			// Honest about the page: with more rows on the server, this is what's
			// shown, not a total.
			countLabel={
				hasMore ? `Showing ${investigations.length} of the ${PAGE_SIZE} most recent` : undefined
			}
			totalCount={hasMore ? undefined : investigations.length}
			trailing={
				<>
					<Select
						value={search.kind ?? "all"}
						onValueChange={(value) =>
							void navigate({
								search: (prev) => ({
									...prev,
									kind: value === "all" ? undefined : (value as InvestigationKindKey),
								}),
							})
						}
					>
						<SelectTrigger size="sm" className="h-7 w-[122px] text-xs">
							{/* The trigger renders before the items register, so it
							    resolves its own label rather than echoing the value. */}
							<SelectValue>{kindFilterLabel}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{KIND_FILTER_VALUES.map((value) => (
								<SelectItem key={value} value={value}>
									{KIND_FILTER_LABEL[value]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<ToolbarSearch
						query={query}
						onSearch={(value) => void navigate({ search: (prev) => ({ ...prev, q: value }) })}
						placeholder="Search subjects and findings"
						className="h-7 w-[200px]"
					/>
				</>
			}
		/>
	)

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Investigations" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							title="Investigations"
							description="Maple investigates an incident, records what it found, and keeps the thread open for follow-ups."
						/>
						<form
							className="flex gap-2"
							onSubmit={(event) => {
								event.preventDefault()
								void handleCreate()
							}}
						>
							<InputGroup className="flex-1">
								<InputGroupAddon>
									<ChatBubbleSparkleIcon />
								</InputGroupAddon>
								<InputGroupInput
									value={subject}
									onChange={(event) => setSubject(event.target.value)}
									placeholder="Ask Maple to investigate — a service, a symptom, a question"
									aria-label="What should Maple investigate?"
								/>
							</InputGroup>
							<Button type="submit" disabled={creating || !subject.trim()}>
								{creating ? "Starting…" : "Investigate"}
							</Button>
						</form>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div className="overflow-hidden rounded-xl border">
							{toolbar}
							{Result.builder(result)
								.onInitial(() => <InvestigationTableSkeleton />)
								.onError((error) => (
									<ErrorState
										error={error}
										title="Investigations could not be loaded"
										onRetry={refresh}
									/>
								))
								.onSuccess(() =>
									investigations.length === 0 ? (
										<HubEmptyState
											view={view}
											filtered={isFiltered}
											onClear={() =>
												void navigate({
													search: (prev) => ({
														...prev,
														kind: undefined,
														q: undefined,
													}),
												})
											}
										/>
									) : (
										<InvestigationTable
											investigations={investigations}
											sort={{ key: sortKey, direction: sortDirection }}
											onSort={handleSort}
										/>
									),
								)
								.render()}
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function HubEmptyState({
	view,
	filtered,
	onClear,
}: {
	view: HubView
	filtered: boolean
	onClear: () => void
}) {
	if (filtered) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>No investigations match these filters</EmptyTitle>
					<EmptyDescription>
						Nothing in {view === "active" ? "Active" : "History"} matches the kind or search you
						picked.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button variant="outline" size="sm" onClick={onClear}>
						Clear filters
					</Button>
				</EmptyContent>
			</Empty>
		)
	}
	return (
		<Empty>
			<EmptyHeader>
				<EmptyTitle>
					{view === "active" ? "Nothing under investigation" : "No finished investigations yet"}
				</EmptyTitle>
				<EmptyDescription>
					{view === "active"
						? "Start one above, or open an issue and choose Start investigation. Maple also opens one automatically when an incident fires."
						: "Investigations you resolve — and any that fail — stay here for reference."}
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	)
}
