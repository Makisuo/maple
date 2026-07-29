import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"

import { formatRelativeTimeOrDate } from "@maple/ui/time-format"
import { ToolbarSearch } from "@maple/ui/components/toolbar"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/utils"

import {
	ArrowRightIcon,
	ChartBarIcon,
	CircleWarningIcon,
	CodeIcon,
	DotsIcon,
	FileIcon,
	GridIcon,
	MagnifierIcon,
	PlusIcon,
	PulseIcon,
	StarFilledIcon,
	StarIcon,
	TextWrapIcon,
} from "@/components/icons"
import { DASHBOARD_SORT_OPTIONS, type DashboardSortOption } from "@/atoms/dashboard-preferences-atoms"
import type { Dashboard } from "@/components/dashboard-builder/types"
import {
	collectTags,
	dashboardDomains,
	dashboardMatches,
	matchesTags,
	readsFromLabel,
	sortDashboards,
	widgetCountLabel,
} from "./dashboard-summary"

const SORT_LABELS: Record<DashboardSortOption, string> = {
	updated: "Recently updated",
	created: "Recently created",
	"name-asc": "Name A–Z",
	"name-desc": "Name Z–A",
	widgets: "Most widgets",
}

export type DashboardScope = "all" | "favorites"

/** The glyph stands for what the dashboard reads, so the lane carries meaning. */
function dashboardGlyph(dashboard: Dashboard) {
	if (dashboard.widgets.length === 0) return GridIcon
	const [primary] = dashboardDomains(dashboard)
	switch (primary) {
		case "Traces":
			return PulseIcon
		case "Logs":
			return TextWrapIcon
		case "Errors":
			return CircleWarningIcon
		case "Metrics":
			return ChartBarIcon
		case "Raw SQL":
			return CodeIcon
		default:
			// No domain at all — every widget is static markdown.
			return FileIcon
	}
}

/**
 * Two fixed-width lanes on the right — scope (count over signals) and recency —
 * so both form columns you can scan straight down. Deliberately spare: a
 * per-visualization breakdown and tag chips were tried here and cut, because
 * neither changed a decision and both cost the row its readability.
 * Mirrors templates/template-list.tsx `TemplateRow`.
 */
function DashboardRow({
	dashboard,
	isFavorite,
	readOnly,
	onToggleFavorite,
	onDelete,
	onDuplicate,
	onExport,
}: {
	dashboard: Dashboard
	isFavorite: boolean
	readOnly: boolean
	onToggleFavorite: (id: string) => void
	onDelete: (dashboard: Dashboard) => void
	onDuplicate: (dashboard: Dashboard) => void
	onExport: (dashboard: Dashboard) => void
}) {
	const Glyph = dashboardGlyph(dashboard)
	const reads = readsFromLabel(dashboard)
	const empty = dashboard.widgets.length === 0

	return (
		<div className="group relative flex items-center border-b border-border last:border-b-0 transition-colors hover:bg-muted/50 focus-within:bg-muted/50">
			<span
				aria-hidden
				className={cn("h-13 w-0.5 shrink-0", isFavorite ? "bg-primary" : "bg-transparent")}
			/>

			{/* The whole row is one link so cmd-click opens a tab; the trailing
			    controls sit above it rather than nested inside it. */}
			<Link
				to="/dashboards/$dashboardId"
				params={{ dashboardId: dashboard.id }}
				className="flex min-w-0 grow items-center gap-3 py-2.5 pr-2 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset rounded-sm"
			>
				<span className="flex size-5.5 shrink-0 items-center justify-center rounded-sm border border-border bg-card">
					<Glyph size={12} className={empty ? "text-muted-foreground" : "text-foreground"} />
				</span>

				<span className="flex min-w-0 grow flex-col gap-0.5">
					<span className="truncate text-sm font-medium text-foreground">{dashboard.name}</span>
					{/* Below sm the scope lane collapses onto this line, so the row keeps
					    its information when the column can't fit. */}
					<span className="text-muted-foreground truncate font-mono text-[11px] sm:hidden">
						{[empty ? "no widgets" : widgetCountLabel(dashboard), reads.short]
							.filter(Boolean)
							.join(" · ")}
					</span>
					{dashboard.description && (
						<span className="text-muted-foreground hidden truncate text-[11px] sm:block">
							{dashboard.description}
						</span>
					)}
				</span>

				{/* One lane, two lines: how much, then what it reads. The per-type
				    breakdown and the tag chips both lived here and were cut — they
				    made the row crowded without changing any decision. */}
				<span title={reads.full} className="hidden w-40 shrink-0 flex-col items-end sm:flex">
					<span className={cn("font-mono text-[11px]", empty ? "text-warning" : "text-foreground")}>
						{empty ? "no widgets" : widgetCountLabel(dashboard)}
					</span>
					<span className="text-muted-foreground truncate font-mono text-[10px]">
						{empty ? "" : reads.short}
					</span>
				</span>

				<span className="text-muted-foreground w-24 shrink-0 text-right font-mono text-[11px]">
					{formatRelativeTimeOrDate(dashboard.updatedAt)}
				</span>
			</Link>

			{/* Always rendered, low-contrast when off: a hover-only star hides the
			    primary organising affordance from touch and keyboard users. */}
			<div className="flex shrink-0 items-center gap-0.5 pr-2 pl-1">
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={isFavorite ? `Unstar ${dashboard.name}` : `Star ${dashboard.name}`}
					aria-pressed={isFavorite}
					onClick={() => onToggleFavorite(dashboard.id)}
					className={isFavorite ? "text-primary" : "text-muted-foreground/40"}
				>
					{isFavorite ? <StarFilledIcon size={14} /> : <StarIcon size={14} />}
				</Button>
				<DashboardRowMenu
					dashboard={dashboard}
					readOnly={readOnly}
					onDelete={onDelete}
					onDuplicate={onDuplicate}
					onExport={onExport}
				/>
			</div>
		</div>
	)
}

function DashboardRowMenu({
	dashboard,
	readOnly,
	onDelete,
	onDuplicate,
	onExport,
}: {
	dashboard: Dashboard
	readOnly: boolean
	onDelete: (dashboard: Dashboard) => void
	onDuplicate: (dashboard: Dashboard) => void
	onExport: (dashboard: Dashboard) => void
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={`More actions for ${dashboard.name}`}
						className="text-muted-foreground"
					/>
				}
			>
				<DotsIcon size={14} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuGroup>
					{/* Export reads the payload the list already holds, so it survives a
					    persistence error. Duplicate and delete write, so they don't. */}
					<DropdownMenuItem onClick={() => onExport(dashboard)}>Export JSON</DropdownMenuItem>
					<DropdownMenuItem disabled={readOnly} onClick={() => onDuplicate(dashboard)}>
						Duplicate
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						disabled={readOnly}
						variant="destructive"
						onClick={() => onDelete(dashboard)}
					>
						Delete…
					</DropdownMenuItem>
					{/* States the reason in the menu itself. A Tooltip here would need a
					    wrapper element, which breaks the menu's roving-index nav. */}
					{readOnly && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuLabel className="font-normal text-[10px] leading-snug">
								Dashboard store unreachable — writes are disabled
							</DropdownMenuLabel>
						</>
					)}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

/**
 * Explains *why* a control is disabled instead of leaving it inert and mute. The
 * wrapper element is required: a disabled button fires no pointer events, so it
 * can never be its own tooltip trigger.
 */
function DisabledReason({ children, reason }: { children: React.ReactNode; reason: string }) {
	return (
		<Tooltip>
			<TooltipTrigger render={<div className="contents" />}>{children}</TooltipTrigger>
			<TooltipContent>{reason}</TooltipContent>
		</Tooltip>
	)
}

const STORE_UNREACHABLE = "Unavailable while the dashboard store is unreachable"

function SectionHeader({
	title,
	count,
	note,
	bordered,
}: {
	title: string
	count: number
	note?: string
	bordered?: boolean
}) {
	return (
		<div className={cn("flex items-center gap-2 pb-2", bordered && "mt-6 pt-2")}>
			<h3 className="text-foreground text-[11px] font-medium tracking-wider uppercase">{title}</h3>
			<span className="text-muted-foreground font-mono text-[11px]">{count}</span>
			<span aria-hidden className="h-px grow bg-border" />
			{note && <span className="text-muted-foreground text-[10px]">{note}</span>}
		</div>
	)
}

interface DashboardListProps {
	dashboards: ReadonlyArray<Dashboard>
	readOnly?: boolean
	favorites: Set<string>
	query: string
	scope: DashboardScope
	tags: ReadonlyArray<string>
	sort: DashboardSortOption
	onQueryChange: (query: string | undefined) => void
	onScopeChange: (scope: DashboardScope) => void
	onTagsChange: (tags: ReadonlyArray<string>) => void
	onSortChange: (sort: DashboardSortOption) => void
	onCreate: () => void
	onDelete: (id: string) => void
	onDuplicate: (dashboard: Dashboard) => void
	onExport: (dashboard: Dashboard) => void
	onToggleFavorite: (id: string) => void
}

export function DashboardList({
	dashboards,
	readOnly = false,
	favorites,
	query,
	scope,
	tags,
	sort,
	onQueryChange,
	onScopeChange,
	onTagsChange,
	onSortChange,
	onCreate,
	onDelete,
	onDuplicate,
	onExport,
	onToggleFavorite,
}: DashboardListProps) {
	const [pendingDelete, setPendingDelete] = useState<Dashboard | null>(null)

	const allTags = useMemo(() => collectTags(dashboards), [dashboards])

	const { favorited, others, matched, scoped } = useMemo(() => {
		const searched = dashboards.filter(
			(dashboard) => dashboardMatches(dashboard, query) && matchesTags(dashboard, tags),
		)
		const inScope =
			scope === "favorites" ? searched.filter((dashboard) => favorites.has(dashboard.id)) : searched
		const sorted = sortDashboards(inScope, sort)
		return {
			favorited: sorted.filter((dashboard) => favorites.has(dashboard.id)),
			others: scope === "favorites" ? [] : sorted.filter((dashboard) => !favorites.has(dashboard.id)),
			matched: searched.length,
			scoped: inScope.length,
		}
	}, [dashboards, query, tags, scope, sort, favorites])

	const searching = query.trim().length > 0
	const filtering = searching || tags.length > 0
	// Distinguish "you have none" from "your filter hid them all" — today's page
	// renders both as the same bare grid.
	const nothingAtAll = dashboards.length === 0
	const nothingMatched = !nothingAtAll && matched === 0
	const scopeHidEverything = !nothingAtAll && matched > 0 && scoped === 0

	const rowProps = {
		readOnly,
		onToggleFavorite,
		onDelete: setPendingDelete,
		onDuplicate,
		onExport,
	}

	return (
		<div className="flex min-h-0 flex-col">
			<div className="flex flex-wrap items-center gap-2 pb-3">
				<ToolbarSearch
					query={query}
					onSearch={onQueryChange}
					placeholder="Search dashboards"
					className="min-w-0 grow sm:max-w-70"
				/>
				<ToggleGroup
					value={[scope]}
					onValueChange={(values) => {
						const next = values[0]
						if (next) onScopeChange(next as DashboardScope)
					}}
					variant="outline"
					size="sm"
					aria-label="Filter dashboards by favorite"
					className="shrink-0"
				>
					<ToggleGroupItem value="all">All</ToggleGroupItem>
					<ToggleGroupItem value="favorites">Favorites</ToggleGroupItem>
				</ToggleGroup>

				<TagFilterMenu allTags={allTags} selected={tags} onChange={onTagsChange} />
				<SortMenu sort={sort} onSortChange={onSortChange} />

				<span className="grow" />
				<span className="text-muted-foreground shrink-0 font-mono text-[11px]">
					{filtering || scope === "favorites"
						? `${scoped} of ${dashboards.length}`
						: `${dashboards.length} of ${dashboards.length}`}
				</span>
			</div>

			{filtering && !nothingAtAll && (
				<div className="flex items-center gap-2 border-y border-border py-2 text-[11px]">
					<span className="font-mono text-foreground">{matched}</span>
					<span className="text-muted-foreground">
						of {dashboards.length} match name, description or tag
					</span>
				</div>
			)}

			{nothingAtAll ? (
				<FirstRunEmpty readOnly={readOnly} onCreate={onCreate} />
			) : nothingMatched ? (
				<Empty className="py-14">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<MagnifierIcon size={17} />
						</EmptyMedia>
						<EmptyTitle>
							{searching
								? `No dashboard matches “${query.trim()}”`
								: "No dashboard carries every selected tag"}
						</EmptyTitle>
						<EmptyDescription>
							{searching
								? "Search covers name, description and tags. A template might mention it."
								: "Tags combine with AND. Drop one to widen the list."}
						</EmptyDescription>
					</EmptyHeader>
					<div className="flex items-center gap-2">
						{searching && (
							<Button variant="outline" size="sm" onClick={() => onQueryChange(undefined)}>
								Clear search
							</Button>
						)}
						{tags.length > 0 && (
							<Button variant="outline" size="sm" onClick={() => onTagsChange([])}>
								Show all
							</Button>
						)}
					</div>
				</Empty>
			) : scopeHidEverything ? (
				<Empty className="py-14">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<StarIcon size={17} />
						</EmptyMedia>
						<EmptyTitle>Nothing starred on this device</EmptyTitle>
						<EmptyDescription>
							Favorites are stored in this browser, not shared with your org. Star a dashboard
							to pin it to the top of the list.
						</EmptyDescription>
					</EmptyHeader>
					<Button variant="outline" size="sm" onClick={() => onScopeChange("all")}>
						Show all dashboards
					</Button>
				</Empty>
			) : (
				<>
					{favorited.length > 0 && (
						<>
							<SectionHeader
								title="Favorites"
								count={favorited.length}
								note="on this device only"
							/>
							{favorited.map((dashboard) => (
								<DashboardRow
									key={dashboard.id}
									dashboard={dashboard}
									isFavorite
									{...rowProps}
								/>
							))}
						</>
					)}
					{others.length > 0 && (
						<>
							<SectionHeader
								title="All dashboards"
								count={others.length}
								bordered={favorited.length > 0}
							/>
							{others.map((dashboard) => (
								<DashboardRow
									key={dashboard.id}
									dashboard={dashboard}
									isFavorite={false}
									{...rowProps}
								/>
							))}
						</>
					)}

					{/* Pinned below the list rather than inside it, so an active filter
					    can never make it read as a result. */}
					<CreateRow readOnly={readOnly} onCreate={onCreate} />
				</>
			)}

			<AlertDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) setPendingDelete(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-destructive/10">
							<CircleWarningIcon className="text-destructive" />
						</AlertDialogMedia>
						<AlertDialogTitle>Delete “{pendingDelete?.name}”?</AlertDialogTitle>
						<AlertDialogDescription>
							This dashboard belongs to the whole org — deleting it removes it for everyone, not
							just you. It can’t be undone. Export the JSON first if you might want it back.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (pendingDelete) onDelete(pendingDelete.id)
								setPendingDelete(null)
							}}
						>
							Delete for everyone
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

function SortMenu({
	sort,
	onSortChange,
}: {
	sort: DashboardSortOption
	onSortChange: (sort: DashboardSortOption) => void
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button variant="outline" size="sm" className="shrink-0" />}>
				{SORT_LABELS[sort]}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				{/* Real radio semantics — the indicator is the selection, and it is
				    announced. Today's menu signals the active sort with a font weight.
				    The label lives *inside* the RadioGroup: it renders Base UI's
				    GroupLabel, which throws without a Group / RadioGroup ancestor. */}
				<DropdownMenuRadioGroup
					value={sort}
					onValueChange={(value) => onSortChange(value as DashboardSortOption)}
				>
					<DropdownMenuLabel>Sort by</DropdownMenuLabel>
					{DASHBOARD_SORT_OPTIONS.map((option) => (
						<DropdownMenuRadioItem key={option} value={option}>
							{SORT_LABELS[option]}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

/**
 * Always rendered — disabled with a reason when the org has no tags yet — so the
 * toolbar never changes shape between orgs.
 */
function TagFilterMenu({
	allTags,
	selected,
	onChange,
}: {
	allTags: ReadonlyArray<string>
	selected: ReadonlyArray<string>
	onChange: (tags: ReadonlyArray<string>) => void
}) {
	const toggle = (tag: string) =>
		onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag])

	// Always rendered so the toolbar keeps its shape between orgs — an org with no
	// tags gets a disabled control that says why, not a missing one.
	if (allTags.length === 0) {
		return (
			<DisabledReason reason="No dashboard carries a tag yet">
				<Button variant="outline" size="sm" disabled className="shrink-0">
					Tags
				</Button>
			</DisabledReason>
		)
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button variant="outline" size="sm" className="shrink-0" />}>
				Tags
				{selected.length > 0 && (
					<Badge className="ml-1.5 h-4 px-1.5 py-0 font-mono text-[9px]">{selected.length}</Badge>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				{/* The label renders Base UI's GroupLabel, which throws without a Group
				    ancestor — so the label and its items are one Group. */}
				<DropdownMenuGroup>
					<DropdownMenuLabel>Filter by tag</DropdownMenuLabel>
					{allTags.map((tag) => (
						<DropdownMenuCheckboxItem
							key={tag}
							checked={selected.includes(tag)}
							closeOnClick={false}
							onClick={() => toggle(tag)}
						>
							{tag}
						</DropdownMenuCheckboxItem>
					))}
				</DropdownMenuGroup>
				{selected.length > 0 && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={() => onChange([])}>Clear tags</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function CreateRow({ readOnly, onCreate }: { readOnly: boolean; onCreate: () => void }) {
	const row = (
		<button
			type="button"
			onClick={onCreate}
			disabled={readOnly}
			className="mt-4 flex w-full shrink-0 items-center gap-3 rounded-md border border-dashed border-input bg-card py-3 pr-4 pl-3 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
		>
			<span className="flex size-5.5 shrink-0 items-center justify-center">
				<PlusIcon size={14} className="text-primary" />
			</span>
			<span className="flex min-w-0 grow flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
				<span className="text-sm font-medium text-foreground">New dashboard</span>
				<span className="text-muted-foreground text-[11px]">
					Start blank, or pick a template already wired to metrics you send.
				</span>
			</span>
			<ArrowRightIcon size={13} className="text-muted-foreground shrink-0" />
		</button>
	)

	if (!readOnly) return row
	return <DisabledReason reason={STORE_UNREACHABLE}>{row}</DisabledReason>
}

/**
 * First run. Templates lead because they check what your services already send,
 * so one of them will render data immediately — a blank canvas will not.
 */
function FirstRunEmpty({ readOnly, onCreate }: { readOnly: boolean; onCreate: () => void }) {
	return (
		<Empty className="py-16">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<GridIcon size={18} />
				</EmptyMedia>
				<EmptyTitle>No dashboards yet</EmptyTitle>
				<EmptyDescription>
					Templates check what your services already send, so you can start from one that will
					render data immediately. Or build from an empty canvas.
				</EmptyDescription>
			</EmptyHeader>
			<div className="flex flex-wrap items-center justify-center gap-2">
				<Button size="sm" render={<Link to="/dashboards/templates" />}>
					Browse templates
				</Button>
				<Button variant="outline" size="sm" disabled={readOnly} onClick={onCreate}>
					Create blank dashboard
				</Button>
			</div>
		</Empty>
	)
}
