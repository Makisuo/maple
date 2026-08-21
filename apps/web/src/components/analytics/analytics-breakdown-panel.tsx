import { useDeferredValue, useMemo, useState, type ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import {
	Dialog,
	DialogDescription,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"

import { ColumnHead, DataTable, useTableSort, type SortDir } from "../infra/primitives/data-table"
import { shareBar } from "../infra/primitives/share-bar"
import { MaximizeIcon } from "@/components/icons"
import type { WebAnalyticsFacetRow } from "@/api/warehouse/web-analytics"
import type { AnalyticsFilterKey } from "./filters"
import { analyticsRowIcon, dimensionHasIcons } from "./row-icon"

/**
 * A ranked row, optionally carrying a page-view count.
 *
 * `views` is present only where we genuinely measure it — the Pages dimension,
 * off `session_events` — and absent everywhere else. It is deliberately not
 * backfilled for the `session_replays` dimensions: a page-view count per
 * referrer or per browser would need a semi-join back to `session_events` on
 * every branch of the twelve-way breakdown union, and an approximation in that
 * column would be indistinguishable from the real one beside it.
 */
export interface BreakdownRow extends WebAnalyticsFacetRow {
	readonly views?: number
	/**
	 * A qualifier the row is grouped by but not named after — the Pages dimension
	 * is ranked per `(host, path)` and displays the path, so two sites sharing
	 * `/settings` are two rows that would otherwise be indistinguishable. Feeds
	 * the row key, the tooltip and the local search, and is what `renderIcon`
	 * reads to pick a favicon.
	 */
	readonly secondary?: string
}

export interface BreakdownDimension {
	/** Tab label. */
	readonly tab: string
	/** Rows for this dimension, already ranked by the server. */
	readonly rows: ReadonlyArray<BreakdownRow>
	/** Which URL filter a row click sets. */
	readonly filterKey: AnalyticsFilterKey
	/** Singular noun for the value column head and the empty state. */
	readonly noun: string
	/** Plural of `noun`. Given explicitly because `+ "s"` mangles half of them. */
	readonly nounPlural: string
	/**
	 * Shown in place of the table when `rows` is empty. Distinguishes "this
	 * dimension is not being collected" from "no traffic matched", which for a
	 * dimension like Country is the difference between a config gap and a fact.
	 */
	readonly emptyMessage?: string
	/** Row-name → display text, for codes whose label differs (country, language). */
	readonly formatValue?: (name: string) => string
	/**
	 * Per-row leading icon, for dimensions whose icon is not derivable from the
	 * row name alone — Pages needs its row's *host* favicon, which lives in
	 * `secondary` rather than in the path the row is named by. Dimensions whose
	 * icon follows from the name keep using `analyticsRowIcon`.
	 */
	readonly renderIcon?: (row: BreakdownRow) => ReactNode
	/**
	 * Column head for `views`, when the dimension carries it. Defaults to "Views";
	 * the Events dimension ranks by firings and says so.
	 */
	readonly viewsLabel?: string
}

type SortKey = "name" | "count" | "views"

/**
 * Identity label for dimensions with no `formatValue`. A module constant so the
 * `?? identityLabel` fallback has a stable identity across renders and can be a
 * memo dependency; an inline `(name) => name` would be a fresh closure each time.
 */
const identityLabel = (name: string): string => name

/**
 * First character only. CSS `capitalize` would title-case every word, turning
 * "entry page" into "Entry Page", and an already-uppercase noun like "OS" has to
 * come through untouched.
 */
const columnLabel = (noun: string): string => noun.charAt(0).toUpperCase() + noun.slice(1)

interface AnalyticsBreakdownPanelProps {
	dimensions: ReadonlyArray<BreakdownDimension>
	/** Currently-set filters, so the selected row can render as selected. */
	activeValue: (key: AnalyticsFilterKey) => string | undefined
	onToggleFilter: (key: AnalyticsFilterKey, value: string) => void
	waiting?: boolean
}

/**
 * The ranked-dimension card: tabs across the top, a searchable table below, each
 * row carrying a bar of its share of the listed total and clickable to filter the
 * page.
 *
 * Two things worth knowing about the numbers it shows:
 *
 * - The share is of the **listed** total, not of all traffic. The server returns
 *   a top-N per dimension, so the tail is absent and the shares of the visible
 *   rows do not sum to 1.
 * - Counts are sessions, not visitors. Every branch of the breakdown query
 *   counts `uniq(SessionId)` — see that file's header for why counting rows
 *   would double-count on a ReplacingMergeTree. A dimension that also supplies
 *   `views` (only Pages does) gains a page-view column and is ranked and barred
 *   by it instead.
 *
 * The row filter is local and network-free (`useDeferredValue` over the already-
 * fetched rows): the point is to find a known value in a 50-row list, and a
 * round trip per keystroke would be slower and would move the ranking underneath
 * the person typing.
 *
 * The card caps its table at 360px because four of these sit two-up under a
 * chart; "Expand table" reopens the same view in a dialog, where the rows get the
 * height and width the card cannot spare.
 */
export function AnalyticsBreakdownPanel({
	dimensions,
	activeValue,
	onToggleFilter,
	waiting,
}: AnalyticsBreakdownPanelProps) {
	// `null` means "nobody has picked a tab yet", which is deliberately distinct
	// from "tab 0". Landing on the first *populated* dimension is what stops a
	// panel whose leading tab is empty for its own reasons (Countries, before geo
	// is enabled) from presenting as broken while five populated tabs sit beside
	// it — and that has to be derived during render, not seeded into state.
	// `useState(firstPopulated)` would freeze the answer at mount, so a panel that
	// mounted before its rows arrived, or whose rows changed under a new filter or
	// time range, would keep pointing at a tab that is now empty.
	const [pickedTab, setPickedTab] = useState<number | null>(null)
	const [query, setQuery] = useState("")
	const [expanded, setExpanded] = useState(false)
	const deferredQuery = useDeferredValue(query)

	const firstPopulated = Math.max(
		dimensions.findIndex((dim) => dim.rows.length > 0),
		0,
	)
	// An explicit pick wins even when it lands on an empty dimension — the person
	// asked for that tab, and silently bouncing them off it would be worse than an
	// honest empty state.
	const activeTab = pickedTab ?? firstPopulated
	const dimension = dimensions[activeTab] ?? dimensions[0]!
	const selected = activeValue(dimension.filterKey)

	const label = dimension.formatValue ?? identityLabel

	// The share is of whichever column ranks the dimension — page views where we
	// have them, sessions otherwise — so the bar always tracks the number the
	// rows are actually ordered by.
	const hasViews = dimension.rows.some((row) => row.views !== undefined)
	const viewsLabel = dimension.viewsLabel ?? "Views"

	const rows = useMemo(() => {
		const total = dimension.rows.reduce((sum, row) => sum + (hasViews ? (row.views ?? 0) : row.count), 0)
		const needle = deferredQuery.trim().toLowerCase()
		return dimension.rows
			.filter((row) =>
				needle
					? label(row.name).toLowerCase().includes(needle) ||
						(row.secondary?.toLowerCase().includes(needle) ?? false)
					: true,
			)
			.map((row) => ({
				...row,
				share: total > 0 ? (hasViews ? (row.views ?? 0) : row.count) / total : 0,
			}))
	}, [dimension, deferredQuery, label, hasViews])

	// Whether *this dimension* carries icons, not whether this row does. Rows
	// without one then reserve the gutter (a non-domain `utm_source` sitting
	// among domains), so one iconless row doesn't unindent itself.
	const hasIcons = dimension.renderIcon !== undefined || dimensionHasIcons(dimension.filterKey)

	const { sorted, sortKey, sortDir, handleSort } = useTableSort(rows, {
		initialKey: (hasViews ? "views" : "count") as SortKey,
		stringKeys: ["name"],
	})

	// Tab, search and sort are shared with the expanded view rather than
	// duplicated into it: expanding is a change of size, not of subject, so the
	// dialog opens on exactly what the card was showing and hands the state back
	// on close.
	const table: BreakdownTableProps = {
		dimension,
		rows: sorted,
		label,
		hasViews,
		viewsLabel,
		hasIcons,
		selected,
		waiting,
		sortKey,
		sortDir,
		onSort: handleSort,
		onSelect: (name) => onToggleFilter(dimension.filterKey, name),
	}

	const tabs = (
		<DimensionTabs
			dimensions={dimensions}
			activeTab={activeTab}
			onPick={(index) => {
				setPickedTab(index)
				setQuery("")
			}}
		/>
	)

	return (
		// Its own container, not `/page`: the panel's width depends on both the page
		// column and whether the breakdown grid is 1- or 2-up, so the panel itself
		// is the only honest measure. The expand dialog portals out of this card —
		// `/panel` classes are card-only (`!ranked`); the dialog keeps viewport
		// queries, which are truthful there via its `max-w-[92vw]`.
		<div className="@container/panel rounded-md border bg-card">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 pt-2.5 pb-2">
				{tabs}
				<FilterInput
					value={query}
					onChange={setQuery}
					nounPlural={dimension.nounPlural}
					className="min-w-24 max-w-40 flex-1"
				/>
			</div>

			{dimension.rows.length === 0 ? (
				<div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
					{dimension.emptyMessage ?? `No ${dimension.noun} data in the selected window.`}
				</div>
			) : (
				<>
					<BreakdownTable {...table} maxHeight={360} surfaceClass="bg-card" />
					<button
						type="button"
						onClick={() => setExpanded(true)}
						className="flex w-full items-center justify-between gap-2 rounded-b-md px-4 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:bg-muted/40 focus-visible:outline-none"
					>
						<span className="flex items-center gap-1.5">
							<MaximizeIcon size={12} />
							Expand table
						</span>
						<span className="font-mono tabular-nums">
							{formatNumber(dimension.rows.length)} {dimension.nounPlural}
						</span>
					</button>
				</>
			)}

			<Dialog open={expanded} onOpenChange={setExpanded}>
				{/* `max-sm:w-full` is load-bearing: the popup drops its max-width on small
				    screens to stick to the bottom edge, so a fixed `w-[900px]` would keep
				    that width and push the table off the side of the phone. */}
				<DialogPopup className="w-[900px] max-w-[92vw] gap-0 p-0 max-sm:w-full">
					<DialogHeader className="gap-3 pb-3">
						<div className="flex flex-col gap-1 pe-8">
							<DialogTitle className="text-base">{dimension.tab}</DialogTitle>
							<DialogDescription>
								Ranked by{" "}
								{hasViews
									? (dimension.viewsLabel?.toLowerCase() ?? "page views")
									: "sessions"}{" "}
								over the selected window. Pick a row to filter the page.
							</DialogDescription>
						</div>
						<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
							{tabs}
							<FilterInput
								value={query}
								onChange={setQuery}
								nounPlural={dimension.nounPlural}
								className="h-7 w-56 text-xs"
								autoFocus
							/>
						</div>
					</DialogHeader>
					<BreakdownTable
						{...table}
						maxHeight="min(62vh, 640px)"
						surfaceClass="bg-popover"
						ranked
						// The row that closes the dialog is the row that changes the page
						// underneath it — leaving it open would leave a ranking on screen
						// that the new filter has already rewritten.
						onSelect={(name) => {
							onToggleFilter(dimension.filterKey, name)
							setExpanded(false)
						}}
					/>
				</DialogPopup>
			</Dialog>
		</div>
	)
}

function DimensionTabs({
	dimensions,
	activeTab,
	onPick,
}: {
	dimensions: ReadonlyArray<BreakdownDimension>
	activeTab: number
	onPick: (index: number) => void
}) {
	return (
		<div className="flex flex-wrap items-center gap-1">
			{dimensions.map((dim, index) => (
				<button
					key={dim.tab}
					type="button"
					onClick={() => onPick(index)}
					className={cn(
						"rounded-sm px-2 py-0.5 text-[11px] transition-colors",
						index === activeTab
							? "bg-muted font-medium text-foreground"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{dim.tab}
				</button>
			))}
		</div>
	)
}

function FilterInput({
	value,
	onChange,
	nounPlural,
	className,
	autoFocus,
}: {
	value: string
	onChange: (value: string) => void
	nounPlural: string
	className?: string
	autoFocus?: boolean
}) {
	return (
		<input
			type="search"
			value={value}
			onChange={(event) => onChange(event.target.value)}
			placeholder={`Filter ${nounPlural}`}
			// Set only by the dialog: someone who expanded the table is one keystroke
			// from searching it, and the card's own input must never steal the page.
			autoFocus={autoFocus}
			className={cn(
				"h-6 rounded-sm border bg-background px-2 text-[11px] placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				className,
			)}
		/>
	)
}

interface BreakdownTableProps {
	dimension: BreakdownDimension
	/** Already filtered by the search box and sorted by the active column. */
	rows: ReadonlyArray<BreakdownRow & { share: number }>
	label: (name: string) => string
	hasViews: boolean
	viewsLabel: string
	hasIcons: boolean
	selected: string | undefined
	waiting?: boolean
	sortKey: SortKey | null
	sortDir: SortDir
	onSort: (key: SortKey) => void
	onSelect: (name: string) => void
}

/**
 * The ranked rows, at whichever size the surface can afford.
 *
 * `ranked` is what the expanded view buys with its extra width: a position
 * column, and the share alongside the page views instead of instead of them.
 * In the card those two columns cost more than they say — a third numeric
 * column truncated every page path to "/app…" — so the row bar carries the
 * share there on its own.
 */
function BreakdownTable({
	dimension,
	rows,
	label,
	hasViews,
	viewsLabel,
	hasIcons,
	selected,
	waiting,
	sortKey,
	sortDir,
	onSort,
	onSelect,
	maxHeight,
	surfaceClass,
	ranked = false,
}: BreakdownTableProps & {
	maxHeight: number | string
	surfaceClass: string
	ranked?: boolean
}) {
	const showShare = ranked || !hasViews
	return (
		<DataTable.Root
			ariaLabel={`${dimension.tab} breakdown`}
			waiting={waiting}
			maxHeight={maxHeight}
			stickySurfaceClass={surfaceClass}
		>
			<DataTable.Head>
				{/* Position and share are what a phone cannot afford: four numeric columns
				    leave a page path about 70px to live in. Both are recoverable — the
				    order is the ranking, the bar is the share. */}
				{ranked ? (
					<ColumnHead<SortKey> label="#" width="w-6" align="right" hidden="max-sm:hidden" />
				) : null}
				<ColumnHead<SortKey>
					label={columnLabel(dimension.noun)}
					width="w-0 flex-1 min-w-0"
					sortKey="name"
					currentKey={sortKey}
					dir={sortDir}
					onSort={onSort}
				/>
				{hasViews ? (
					<ColumnHead<SortKey>
						label={viewsLabel}
						width={ranked ? "w-16 sm:w-24" : "w-16"}
						align="right"
						sortKey="views"
						currentKey={sortKey}
						dir={sortDir}
						onSort={onSort}
					/>
				) : null}
				<ColumnHead<SortKey>
					label="Sessions"
					width={ranked ? "w-16 sm:w-24" : hasViews ? "w-20" : "w-24"}
					align="right"
					sortKey="count"
					currentKey={sortKey}
					dir={sortDir}
					onSort={onSort}
					// In the card, Views is the ranking column for pages — Sessions is
					// the number a very narrow panel can afford to drop.
					hidden={!ranked && hasViews ? "hidden @min-[380px]/panel:flex" : undefined}
				/>
				{showShare ? (
					<ColumnHead<SortKey>
						label="Share"
						width="w-16"
						align="right"
						// Card mode sheds Share by panel width — the row's background bar
						// already carries it. The dialog sheds by viewport, as before.
						hidden={ranked ? "max-sm:hidden" : "hidden @min-[380px]/panel:flex"}
					/>
				) : null}
			</DataTable.Head>
			{rows.length === 0 ? (
				<DataTable.Empty>No {dimension.noun} matches that filter.</DataTable.Empty>
			) : (
				rows.map((row, index) => {
					const isSelected = selected === row.name
					const icon = dimension.renderIcon
						? dimension.renderIcon(row)
						: hasIcons
							? analyticsRowIcon(dimension.filterKey, row.name)
							: undefined
					return (
						<button
							key={row.secondary ? `${row.secondary}${row.name}` : row.name}
							type="button"
							onClick={() => onSelect(row.name)}
							aria-pressed={isSelected}
							// The bar is a background-image so it composes with the
							// selected row's background-color instead of overwriting it.
							style={shareBar(row.share)}
							className={cn(
								"group flex w-full items-center gap-3 border-b border-border/40 px-3 py-2 text-left transition-colors last:border-0 @min-[420px]/panel:gap-4 @min-[420px]/panel:px-4",
								// Hover and focus lift the whole row from behind the fill, so a
								// long bar and a short one light up by the same amount.
								// `--foreground`, not `--muted`: muted is barely above this
								// surface in dark and a mid grey in light, so no single alpha of
								// it reads as a hover in both. The text colour is the one token
								// guaranteed to contrast with whatever the row sits on.
								"hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] focus-visible:outline-none",
								// Selection is a rule down the leading edge rather than a wash:
								// a wash in the primary hue is precisely what the fill already
								// is, and at 47% share the two were the same picture. `shadow`
								// rather than a border so nothing shifts by 3px.
								isSelected && "bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]",
							)}
						>
							{/* Position in the order on screen, so it stays true when a
							    different column takes over the sort. */}
							{ranked ? (
								<span className="w-6 text-right font-mono text-[11px] tabular-nums text-muted-foreground/60 max-sm:hidden">
									{index + 1}
								</span>
							) : null}
							<span className="flex w-0 min-w-0 flex-1 items-center gap-2">
								{icon ?? (hasIcons ? <span className="size-4 shrink-0" aria-hidden /> : null)}
								<span
									className={cn(
										"min-w-0 truncate text-[12px] transition-colors",
										isSelected
											? "font-medium text-foreground"
											: "text-foreground/90 group-hover:text-foreground",
									)}
									title={row.secondary ? `${row.secondary}${row.name}` : label(row.name)}
								>
									{label(row.name)}
								</span>
							</span>
							{hasViews ? (
								<span
									className={cn(
										"text-right font-mono text-[11px] tabular-nums",
										ranked ? "w-16 sm:w-24" : "w-16",
									)}
								>
									{formatNumber(row.views ?? 0)}
								</span>
							) : null}
							<span
								className={cn(
									"text-right font-mono text-[11px] tabular-nums",
									ranked ? "w-16 sm:w-24" : hasViews ? "w-20" : "w-24",
									hasViews && !ranked && "text-muted-foreground",
									!ranked && hasViews && "hidden @min-[380px]/panel:inline-block",
								)}
							>
								{formatNumber(row.count)}
							</span>
							{showShare ? (
								<span
									className={cn(
										"w-16 text-right font-mono text-[11px] tabular-nums text-muted-foreground",
										ranked ? "max-sm:hidden" : "hidden @min-[380px]/panel:inline-block",
									)}
								>
									{formatPercent(row.share)}
								</span>
							) : null}
						</button>
					)
				})
			)}
		</DataTable.Root>
	)
}
