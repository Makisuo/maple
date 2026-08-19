import { useMemo, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Exit, Schema } from "effect"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { displayError } from "@/lib/error-messages"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Button, buttonVariants } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { ToolbarSearch } from "@maple/ui/components/toolbar"
import { toastManager } from "@maple/ui/components/ui/toast"
import { formatDuration } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"

import { ErrorState } from "@/components/common/error-state"
import { ListToolbar } from "@/components/common/list-toolbar"

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
import { InvestigateBar } from "@/components/investigations/investigate-bar"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

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
} satisfies Record<InvestigationKindKey | "all", string>

const KIND_FILTER_VALUES = Object.keys(KIND_FILTER_LABEL) as ReadonlyArray<InvestigationKindKey | "all">

const kindFilterLabel = (value: unknown): string =>
	typeof value === "string" && value in KIND_FILTER_LABEL
		? KIND_FILTER_LABEL[value as InvestigationKindKey | "all"]
		: KIND_FILTER_LABEL.all

/**
 * Sorting moved off the column headers, because the list no longer has any. Each
 * option is a `key:direction` pair so the control reads as an intent ("Most
 * severe") rather than a field plus a separate direction toggle.
 */
const SORT_OPTIONS = [
	{ value: "updated:desc", label: "Newest first" },
	{ value: "updated:asc", label: "Oldest first" },
	{ value: "severity:desc", label: "Most severe" },
	{ value: "confidence:desc", label: "Most confident" },
] as const

const sortLabel = (value: unknown): string =>
	SORT_OPTIONS.find((option) => option.value === value)?.label ?? SORT_OPTIONS[0].label

function InvestigationsHub() {
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()
	const view: HubView = search.view ?? "active"
	const sortKey: InvestigationSortKey = search.sort ?? "updated"
	const sortDirection = search.dir ?? "desc"
	const query = search.q ?? ""
	const isFiltered = query.trim().length > 0 || search.kind !== undefined

	const [creating, setCreating] = useState(false)
	const listQuery = retainedQueryV2("investigations", "list", {
		query: { limit: PAGE_SIZE },
		reactivityKeys: ["investigations"],
	})
	const result = useAtomValue(listQuery)
	const refresh = useAtomRefresh(listQuery)
	// The hub is where someone stands when they ask "why is nothing being
	// investigated?", so the answer has to be here rather than three clicks away
	// in settings.
	const budget = Result.builder(
		useAtomValue(
			retainedInternalQuery("aiTriage", "getSettings", { reactivityKeys: ["aiTriageSettings"] }),
		),
	)
		.onSuccess((value) => value)
		.orElse(() => null)
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

	const handleCreate = async (title: string) => {
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
			void navigate({ to: "/investigations/$id", params: { id: created.value.id } })
		} else {
			const { title, message } = displayError(created)
			toastManager.add({ title, description: message, type: "error" })
		}
	}

	// Nothing at all — not "nothing matching your filters". The hero belongs to a
	// workspace that has never run one, and it replaces the whole page rather than
	// sitting inside an empty table shell.
	const isFirstRun = Result.isSuccess(result) && page.length === 0

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
					<Select
						value={`${sortKey}:${sortDirection}`}
						onValueChange={(value) => {
							const [key, direction] = String(value).split(":")
							void navigate({
								search: (prev) => ({
									...prev,
									// Defaults drop out of the URL entirely.
									sort: key === "updated" ? undefined : (key as InvestigationSortKey),
									dir: direction === "desc" ? undefined : "asc",
								}),
							})
						}}
					>
						<SelectTrigger size="sm" className="h-7 w-[136px] text-xs">
							<SelectValue>{sortLabel}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{SORT_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
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
					{isFirstRun ? (
						<DashboardLayout.Scroll>
							<HubHero onSubmit={handleCreate} busy={creating} />
						</DashboardLayout.Scroll>
					) : (
						<>
							<DashboardLayout.Sticky>
								{budget?.enabled && budget.passesExhausted ? (
									<BudgetExhaustedNotice resumesAt={budget.resumesAt} />
								) : null}
								<TriageStrip investigations={page} />
								<InvestigateBar onSubmit={handleCreate} busy={creating} />
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
												<InvestigationTable investigations={investigations} />
											),
										)
										.render()}
								</div>
							</DashboardLayout.Scroll>
						</>
					)}
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Budget notice
 * -----------------------------------------------------------------------------------------------*/

/**
 * Says why nothing new is starting.
 *
 * Not dismissible and not a toast: the condition lasts until UTC midnight and is
 * the direct answer to the question that brings someone to this page. It reads
 * "paused", never "off" — high and critical incidents still start from the
 * reserved slice while this is showing, and an operator who takes it as a total
 * stop will go looking for a bug that is not there.
 */
function BudgetExhaustedNotice({ resumesAt }: { resumesAt: string | null }) {
	const resumes = resumesAt === null ? null : new Date(toEpochMs(resumesAt))
	return (
		<div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
			<span className="font-medium text-foreground">Automatic triage paused</span>
			<span className="text-muted-foreground">
				Today&apos;s model budget is spent
				{resumes === null
					? "."
					: `; it resets ${resumes.toLocaleString(undefined, { timeStyle: "short", dateStyle: "medium" })}.`}{" "}
				High and critical incidents still start.
			</span>
			<Link to="/settings" className={cn(buttonVariants({ size: "sm", variant: "ghost" }), "ml-auto")}>
				Raise the limit
			</Link>
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Triage strip
 * -----------------------------------------------------------------------------------------------*/

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Three numbers, above the fold: what is running, what is waiting on a human,
 * and what the last day cost. Derived from the fetched page rather than a
 * separate request — the page is the 100 most recent, which is the window these
 * counts are about anyway.
 */
function TriageStrip({ investigations }: { investigations: ReadonlyArray<V2Investigation> }) {
	const stats = useMemo(() => {
		const running = investigations.filter((entry) => entry.status === "investigating")
		const review = investigations.filter((entry) => entry.status === "diagnosed")
		const cutoff = Date.now() - DAY_MS
		const resolved = investigations.filter(
			(entry) => entry.status === "resolved" && toEpochMs(entry.updated_at) >= cutoff,
		)

		// Dispatched lenses, not the computed size: a single-pass run persists a
		// size of 1 with zero lenses, so summing size reports lenses in flight for
		// runs that never dispatched one.
		const lensesInFlight = running.reduce((total, entry) => total + entry.lens_runs.length, 0)
		const critical = review.filter(
			(entry) => (entry.severity ?? entry.snapshot.severity) === "critical",
		).length

		const durations = resolved
			.map((entry) =>
				entry.diagnosed_at ? toEpochMs(entry.diagnosed_at) - toEpochMs(entry.created_at) : null,
			)
			.filter((ms): ms is number => ms !== null && Number.isFinite(ms) && ms >= 0)
			.sort((a, b) => a - b)
		const median = durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : null
		const avgLenses =
			resolved.length > 0
				? resolved.reduce((total, entry) => total + entry.lens_runs.length, 0) / resolved.length
				: null

		return { running, review, resolved, lensesInFlight, critical, median, avgLenses }
	}, [investigations])

	return (
		// Same grid-with-border-cells reasoning as the detail page's impact strip:
		// standalone divider elements strand themselves at the end of a row when the
		// last stat wraps.
		<div className="grid grid-cols-1 gap-y-5 sm:grid-cols-3 [&>*+*]:border-l [&>*+*]:pl-8 max-sm:[&>*+*]:border-l-0 max-sm:[&>*+*]:pl-0">
			<TriageStat
				label="Investigating now"
				dot="bg-primary"
				labelTone="text-primary"
				value={stats.running.length}
				detail={
					stats.running.length === 0
						? "nothing in flight"
						: `${stats.lensesInFlight} ${stats.lensesInFlight === 1 ? "lens" : "lenses"} in flight`
				}
			/>
			<TriageStat
				label="Needs review"
				dot="bg-severity-warn"
				labelTone="text-severity-warn"
				value={stats.review.length}
				detail={
					stats.review.length === 0
						? "nothing waiting on you"
						: stats.critical > 0
							? `${stats.critical} critical`
							: "diagnosed, not resolved"
				}
			/>
			<TriageStat
				label="Resolved · 24h"
				dot="bg-muted-foreground"
				labelTone="text-muted-foreground"
				valueTone="text-muted-foreground"
				value={stats.resolved.length}
				detail={
					stats.median === null
						? "none in the last day"
						: `median ${formatDuration(stats.median)}${
								stats.avgLenses === null ? "" : ` · ${stats.avgLenses.toFixed(1)} lenses`
							}`
				}
			/>
		</div>
	)
}

function TriageStat({
	label,
	dot,
	labelTone,
	value,
	valueTone = "text-foreground",
	detail,
}: {
	label: string
	dot: string
	labelTone: string
	value: number
	valueTone?: string
	detail: string
}) {
	return (
		<div className="flex min-w-0 flex-col gap-2.5">
			<div className="flex items-center gap-1.75">
				<span aria-hidden className={`size-1.5 shrink-0 rounded-[3px] ${dot}`} />
				<span className={`text-[10px] font-medium uppercase tracking-[0.12em] ${labelTone}`}>
					{label}
				</span>
			</div>
			<div className="flex items-baseline gap-2.5">
				<span
					className={`font-display text-2xl font-semibold tracking-tight tabular-nums ${valueTone}`}
				>
					{value}
				</span>
				<span className="text-sm text-muted-foreground">{detail}</span>
			</div>
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Empty states
 * -----------------------------------------------------------------------------------------------*/

const HERO_SUGGESTIONS = [
	"Why did checkout latency spike this afternoon?",
	"What changed before the last error burst?",
	"Which service is slowest right now, and why?",
]

/**
 * The first-run page. A workspace with no investigations has nothing to filter,
 * sort or triage, so the table chrome is all cost and no information — the whole
 * page becomes the invitation instead.
 */
function HubHero({ onSubmit, busy }: { onSubmit: (title: string) => void | Promise<void>; busy: boolean }) {
	return (
		<div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-5 py-16">
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-primary">
				Investigations
			</span>
			<h1 className="font-display text-[28px] font-semibold leading-9 tracking-tight text-foreground">
				Ask, and Maple goes and finds out.
			</h1>
			<p className="max-w-xl text-sm leading-6 text-muted-foreground">
				It dispatches up to five agents, each attacking the problem from a different angle — deploys,
				dependencies, saturation, traffic — then a validator ranks what they found and promotes one
				answer.
			</p>
			<InvestigateBar
				onSubmit={onSubmit}
				busy={busy}
				accent
				placeholder="A service, a symptom, a question…"
			/>
			<ul className="flex flex-col gap-2">
				{HERO_SUGGESTIONS.map((suggestion) => (
					<li key={suggestion}>
						<button
							type="button"
							disabled={busy}
							onClick={() => void onSubmit(suggestion)}
							className="flex w-full items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 text-left text-sm text-foreground transition-colors hover:border-ring hover:bg-accent/40 disabled:opacity-60"
						>
							<span aria-hidden className="shrink-0 text-muted-foreground">
								›
							</span>
							{suggestion}
						</button>
					</li>
				))}
			</ul>
			<p className="flex items-baseline gap-2 text-sm text-muted-foreground">
				<span aria-hidden className="size-1.5 shrink-0 translate-y-[-2px] rounded-full bg-primary" />
				Maple also opens an investigation on its own whenever an incident fires — you will find those
				here too.
			</p>
		</div>
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
