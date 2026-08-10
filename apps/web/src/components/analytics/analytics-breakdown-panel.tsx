import { useDeferredValue, useMemo, useState } from "react"

import { cn } from "@maple/ui/lib/utils"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"

import { ColumnHead, DataTable, useTableSort } from "../infra/primitives/data-table"
import { shareTint } from "../infra/primitives/share-tint"
import type { WebAnalyticsFacetRow } from "@/api/warehouse/web-analytics"
import type { AnalyticsFilterKey } from "./filters"

export interface BreakdownDimension {
	/** Tab label. */
	readonly tab: string
	/** Rows for this dimension, already ranked by the server. */
	readonly rows: ReadonlyArray<WebAnalyticsFacetRow>
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

type SortKey = "name" | "count"

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
 *   would double-count on a ReplacingMergeTree.
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
	// Open on the first dimension that actually has rows. Otherwise a panel whose
	// leading tab is empty for its own reasons (Countries, before geo is enabled)
	// presents as a broken panel, hiding the five populated tabs beside it.
	const firstPopulated = Math.max(
		dimensions.findIndex((dim) => dim.rows.length > 0),
		0,
	)
	const [activeTab, setActiveTab] = useState(firstPopulated)
	const [query, setQuery] = useState("")
	const deferredQuery = useDeferredValue(query)

	const dimension = dimensions[activeTab] ?? dimensions[0]!
	const selected = activeValue(dimension.filterKey)
	const label = dimension.formatValue ?? ((name: string) => name)

	const rows = useMemo(() => {
		const total = dimension.rows.reduce((sum, row) => sum + row.count, 0)
		const needle = deferredQuery.trim().toLowerCase()
		return dimension.rows
			.filter((row) => (needle ? label(row.name).toLowerCase().includes(needle) : true))
			.map((row) => ({ ...row, share: total > 0 ? row.count / total : 0 }))
	}, [dimension, deferredQuery, label])

	const dimensionFootnote = dimension.coverageDependent ? footnote : undefined

	const { sorted, sortKey, sortDir, handleSort } = useTableSort(rows, {
		initialKey: "count" as SortKey,
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
								setActiveTab(index)
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
					maxHeight={320}
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
						<ColumnHead<SortKey>
							label="Sessions"
							width="w-24"
							align="right"
							sortKey="count"
							currentKey={sortKey}
							dir={sortDir}
							onSort={handleSort}
						/>
						<ColumnHead<SortKey> label="Share" width="w-16" align="right" />
					</DataTable.Head>
					{sorted.length === 0 ? (
						<DataTable.Empty>No {dimension.noun} matches that filter.</DataTable.Empty>
					) : (
						sorted.map((row) => {
							const isSelected = selected === row.name
							return (
								<button
									key={row.name}
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
									<span
										className={cn(
											"min-w-0 flex-1 truncate text-[12px]",
											isSelected ? "font-medium text-foreground" : "text-foreground/90",
										)}
										title={label(row.name)}
									>
										{label(row.name)}
									</span>
									<span className="w-24 text-right font-mono text-[11px] tabular-nums">
										{formatNumber(row.count)}
									</span>
									<span className="w-16 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
										{formatPercent(row.share)}
									</span>
								</button>
							)
						})
					)}
				</DataTable.Root>
			)}

			{/* The share sentence describes a ranking, so it is suppressed when there is
			    nothing ranked — the coverage footnote is the useful half there. */}
			{dimensionFootnote || dimension.rows.length > 0 ? (
				<div className="px-4 py-2 text-[10px] text-muted-foreground/80">
					{dimension.rows.length > 0
						? `Share is of the ${formatNumber(dimension.rows.length)} listed ${dimension.nounPlural}, not of all traffic.`
						: null}
					{dimensionFootnote ? ` ${dimensionFootnote}` : ""}
				</div>
			) : null}
		</div>
	)
}
