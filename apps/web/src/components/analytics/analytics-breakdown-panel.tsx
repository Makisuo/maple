import { useDeferredValue, useMemo, useState, type ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"

import { ColumnHead, DataTable, useTableSort } from "../infra/primitives/data-table"
import { shareTint } from "../infra/primitives/share-tint"
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
	 * A note about *this dimension*, shown beside the share sentence. Distinct
	 * from the panel-wide `footnote`, which is the coverage caveat: a dimension
	 * can have something to say (Pages: "these counts cover every session") that
	 * is not about coverage at all, and is in fact the opposite of a caveat.
	 */
	readonly note?: string
	/**
	 * Per-row leading icon, for dimensions whose icon is not derivable from the
	 * row name alone — Pages needs its row's *host* favicon, which lives in
	 * `secondary` rather than in the path the row is named by. Dimensions whose
	 * icon follows from the name keep using `analyticsRowIcon`.
	 */
	readonly renderIcon?: (row: BreakdownRow) => ReactNode
	/**
	 * True when the column belongs to the migration-0011 analytics block, so the
	 * panel's coverage caveat applies to it.
	 *
	 * Not every dimension here is affected, and saying otherwise is a lie the UI
	 * can be caught in: `BrowserName`, `OsName`, `DeviceType` and `Country` predate
	 * that migration and are populated for every session, while `Referrer`, `Utm*`,
	 * `EntryPath`, `Host` and `Language` are not. Attaching one panel-wide caveat
	 * told an operator that browser data covered a fraction of sessions while the
	 * filter sidebar beside it counted 41k Chrome sessions.
	 */
	readonly coverageDependent?: boolean
}

type SortKey = "name" | "count" | "views"

/**
 * Identity label for dimensions with no `formatValue`. A module constant so the
 * `?? identityLabel` fallback has a stable identity across renders and can be a
 * memo dependency; an inline `(name) => name` would be a fresh closure each time.
 */
const identityLabel = (name: string): string => name

interface AnalyticsBreakdownPanelProps {
	title: string
	dimensions: ReadonlyArray<BreakdownDimension>
	/** Currently-set filters, so the selected row can render as selected. */
	activeValue: (key: AnalyticsFilterKey) => string | undefined
	onToggleFilter: (key: AnalyticsFilterKey, value: string) => void
	waiting?: boolean
	/**
	 * The coverage caveat, applied only to dimensions marked `coverageDependent`.
	 */
	footnote?: string
}

/**
 * The ranked-dimension card: tabs across the top, a searchable table below, each
 * row tinted to its share of the listed total and clickable to filter the page.
 *
 * Two things worth knowing about the numbers it shows:
 *
 * - The share is of the **listed** total, not of all traffic. The server returns
 *   a top-N per dimension, so the tail is absent and the shares of the visible
 *   rows do not sum to 1. The footer says as much rather than implying they do.
 * - Counts are sessions, not visitors. Every branch of the breakdown query
 *   counts `uniq(SessionId)` — see that file's header for why counting rows
 *   would double-count on a ReplacingMergeTree. A dimension that also supplies
 *   `views` (only Pages does) gains a page-view column and is ranked and tinted
 *   by it instead.
 *
 * The row filter is local and network-free (`useDeferredValue` over the already-
 * fetched rows): the point is to find a known value in a 50-row list, and a
 * round trip per keystroke would be slower and would move the ranking underneath
 * the person typing.
 */
export function AnalyticsBreakdownPanel({
	title,
	dimensions,
	activeValue,
	onToggleFilter,
	waiting,
	footnote,
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
	// have them, sessions otherwise — so the tint always tracks the number the
	// rows are actually ordered by.
	const hasViews = dimension.rows.some((row) => row.views !== undefined)

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

	const dimensionFootnote = dimension.coverageDependent ? footnote : undefined

	// Whether *this dimension* carries icons, not whether this row does. Rows
	// without one then reserve the gutter (a non-domain `utm_source` sitting
	// among domains), so one iconless row doesn't unindent itself.
	const hasIcons = dimension.renderIcon !== undefined || dimensionHasIcons(dimension.filterKey)

	const { sorted, sortKey, sortDir, handleSort } = useTableSort(rows, {
		initialKey: (hasViews ? "views" : "count") as SortKey,
		stringKeys: ["name"],
	})

	return (
		<div className="rounded-md border bg-card">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 pt-2.5 pb-2">
				<div className="flex flex-wrap items-center gap-1">
					<span className="mr-1 text-[11px] font-medium text-muted-foreground">{title}</span>
					{dimensions.map((dim, index) => (
						<button
							key={dim.tab}
							type="button"
							onClick={() => {
								setPickedTab(index)
								setQuery("")
							}}
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
				<input
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={`Filter ${dimension.nounPlural}`}
					className="h-6 w-40 rounded-sm border bg-background px-2 text-[11px] placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				/>
			</div>

			{dimension.rows.length === 0 ? (
				<div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
					{dimension.emptyMessage ?? `No ${dimension.noun} data in the selected window.`}
				</div>
			) : (
				<DataTable.Root
					ariaLabel={`${dimension.tab} breakdown`}
					waiting={waiting}
					maxHeight={360}
					stickySurfaceClass="bg-card"
				>
					<DataTable.Head>
						<ColumnHead<SortKey>
							label={dimension.noun}
							width="flex-1 min-w-0"
							sortKey="name"
							currentKey={sortKey}
							dir={sortDir}
							onSort={handleSort}
						/>
						{hasViews ? (
							<ColumnHead<SortKey>
								label="Views"
								width="w-16"
								align="right"
								sortKey="views"
								currentKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
							/>
						) : null}
						<ColumnHead<SortKey>
							label="Sessions"
							width={hasViews ? "w-20" : "w-24"}
							align="right"
							sortKey="count"
							currentKey={sortKey}
							dir={sortDir}
							onSort={handleSort}
						/>
						{/* Dropped once a Views column is present. These cards are half-width,
						    and a third numeric column truncated every page path to "/app…" —
						    the row tint already encodes the share, so the column was the
						    least informative thing competing for the space. */}
						{hasViews ? null : <ColumnHead<SortKey> label="Share" width="w-16" align="right" />}
					</DataTable.Head>
					{sorted.length === 0 ? (
						<DataTable.Empty>No {dimension.noun} matches that filter.</DataTable.Empty>
					) : (
						sorted.map((row) => {
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
									onClick={() => onToggleFilter(dimension.filterKey, row.name)}
									aria-pressed={isSelected}
									// The tint is a background-image so it composes with the
									// selected row's background-color instead of overwriting it.
									style={{ backgroundImage: shareTint(row.share) }}
									className={cn(
										"flex w-full items-center gap-4 border-b border-border/40 px-4 py-2 text-left transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
										isSelected && "bg-primary/10",
									)}
								>
									<span className="flex min-w-0 flex-1 items-center gap-2">
										{icon ??
											(hasIcons ? (
												<span className="size-4 shrink-0" aria-hidden />
											) : null)}
										<span
											className={cn(
												"min-w-0 truncate text-[12px]",
												isSelected
													? "font-medium text-foreground"
													: "text-foreground/90",
											)}
											title={
												row.secondary
													? `${row.secondary}${row.name}`
													: label(row.name)
											}
										>
											{label(row.name)}
										</span>
									</span>
									{hasViews ? (
										<span className="w-16 text-right font-mono text-[11px] tabular-nums">
											{formatNumber(row.views ?? 0)}
										</span>
									) : null}
									<span
										className={cn(
											"text-right font-mono text-[11px] tabular-nums",
											hasViews ? "w-20 text-muted-foreground" : "w-24",
										)}
									>
										{formatNumber(row.count)}
									</span>
									{hasViews ? null : (
										<span className="w-16 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
											{formatPercent(row.share)}
										</span>
									)}
								</button>
							)
						})
					)}
				</DataTable.Root>
			)}

			{/* The share sentence describes a ranking, so it is suppressed when there is
			    nothing ranked — the notes are the useful half there. */}
			{dimensionFootnote || dimension.note || dimension.rows.length > 0 ? (
				<div className="px-4 py-2 text-[10px] text-muted-foreground/80">
					{/* Names whichever thing is actually carrying the share: the column
					    where there is one, the row shading where the Views column has
					    taken its place. */}
					{dimension.rows.length > 0
						? `${hasViews ? "Row shading shows each row's share" : "Share is"} of the ${formatNumber(dimension.rows.length)} listed ${dimension.nounPlural}, not of all traffic.`
						: null}
					{dimension.note ? ` ${dimension.note}` : ""}
					{dimensionFootnote ? ` ${dimensionFootnote}` : ""}
				</div>
			) : null}
		</div>
	)
}
