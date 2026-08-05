import { memo } from "react"
import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"
import { ArrowUpDownIcon } from "@/components/icons"
import { useTableSort } from "@/hooks/use-table-sort"
import { formatValueByUnit } from "@maple/ui/lib/format"

interface TableWidgetProps {
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
	rowLimit?: number
}

/**
 * Render one table cell using the same unit vocabulary as charts and stat tiles.
 *
 * This delegates to `formatValueByUnit` rather than keeping its own switch: the
 * parallel implementation this replaces had already drifted, silently missing
 * `bytes` entirely, so a byte column rendered as a bare `314572800` in a table
 * while the identical value read "314.6 MB" in a chart. Delegating means a unit
 * added to @maple/ui works everywhere at once.
 *
 * Unitless columns deliberately stay raw. They carry ids, commit shas and small
 * counts, where abbreviating `1234` to "1.2K" destroys the value being read.
 */
export function formatCellValue(value: unknown, unit?: string): string {
	if (value == null) return "-"
	const num = Number(value)
	if (Number.isNaN(num)) return String(value)
	if (!unit) return String(value)
	return formatValueByUnit(num, unit)
}

/**
 * Whether a cell holds a number — including one quoted as a string, which is how
 * 64-bit counts arrive from BYO-ClickHouse.
 */
function isNumericCell(value: unknown): boolean {
	if (typeof value === "number") return true
	return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
}

/**
 * A stable key per row, so re-sorting moves rows instead of rewriting their
 * cells in place. Derived from the first visible column — the group key in a
 * breakdown table. Rows that repeat that value (possible in an ungrouped table)
 * get an occurrence suffix rather than a row index: a stable sort keeps
 * duplicates in the same relative order, so the suffix survives a re-sort.
 */
export function buildRowKeys(rows: ReadonlyArray<Record<string, unknown>>, field?: string): string[] {
	const seen = new Map<string, number>()
	return rows.map((row, i) => {
		if (!field) return String(i)
		const base = String(row[field])
		const count = seen.get(base) ?? 0
		seen.set(base, count + 1)
		return count === 0 ? base : `${base}#${count}`
	})
}

/**
 * Progressive column reveal, keyed off the widget card's own width.
 *
 * Table columns here are whatever the query returned (or whatever the author
 * configured), so there is no fixed "these are the secondary ones" list the way
 * `TRACE_COLUMNS` has. The rule instead is positional: the first column — the
 * group key in a breakdown table — always shows, and each column after it needs
 * another ~100px of card before it earns its place. Without this, a table tile
 * on a 6- or 1-column grid renders six columns of ellipsis.
 *
 * The classes must be written out as literals; Tailwind scans source text, so a
 * template-interpolated `@min-[${n}px]` would never be generated.
 */
const COLUMN_VISIBILITY = [
	"",
	"hidden @min-[220px]/widget:table-cell",
	"hidden @min-[320px]/widget:table-cell",
	"hidden @min-[420px]/widget:table-cell",
	"hidden @min-[520px]/widget:table-cell",
	"hidden @min-[620px]/widget:table-cell",
]

export function columnVisibilityClass(index: number): string {
	return COLUMN_VISIBILITY[Math.min(index, COLUMN_VISIBILITY.length - 1)]
}

function getCellThresholdColor(
	value: unknown,
	thresholds?: Array<{ value: number; color: string }>,
): string | undefined {
	if (!thresholds || thresholds.length === 0) return undefined
	if (value == null || typeof value === "object") return undefined
	const num = typeof value === "number" ? value : Number(value)
	if (Number.isNaN(num)) return undefined
	const sorted = thresholds.toSorted((a, b) => b.value - a.value)
	for (const t of sorted) {
		if (num >= t.value) return t.color
	}
	return undefined
}

export const TableWidget = memo(function TableWidget({
	dataState,
	display,
	mode,
	rowLimit,
}: TableWidgetProps) {
	const displayName = display.title || "Untitled"
	const rows =
		dataState.status === "ready" && Array.isArray(dataState.data)
			? (dataState.data as Record<string, unknown>[])
			: []
	const columns = display.columns ?? []

	type ColumnDef = {
		field: string
		header: string
		unit?: string
		width?: number
		align?: "left" | "center" | "right"
		hidden?: boolean
		thresholds?: Array<{ value: number; color: string }>
	}

	// If no columns configured, auto-detect from first row
	const baseColumns: ColumnDef[] =
		columns.length > 0
			? columns
			: rows.length > 0
				? Object.keys(rows[0]).map((key) => ({
						field: key,
						header: key,
					}))
				: []
	const effectiveColumns = baseColumns.filter((col) => !col.hidden)

	// Sorting is view-local: a header click never writes to the widget, so
	// reading a dashboard can't dirty it. `initialKey: null` keeps the warehouse
	// ordering (`ORDER BY count DESC`, or the breakdown merge) until the reader
	// asks for something else, and `resettable` lets a third click return to it.
	// Text columns read best A→Z on first click, numbers biggest-first. The
	// columns are whatever the query returned, so the split is inferred from the
	// first row rather than declared.
	const stringFields = rows.length > 0 ? Object.keys(rows[0]).filter((f) => !isNumericCell(rows[0][f])) : []
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<Record<string, unknown>, string>(rows, {
		initialKey: null,
		resettable: true,
		stringKeys: stringFields,
	})

	// The warehouse `LIMIT` picked the top-N before the rows ever reached the
	// browser, so a client sort re-ranks a truncated set. Say so when the row
	// count is sitting exactly on the cap.
	const truncated = rowLimit != null && rows.length >= rowLimit
	const rowKeys = buildRowKeys(sorted, effectiveColumns[0]?.field)

	return (
		<WidgetFrame
			title={displayName}
			dataState={dataState}
			mode={mode}
			contentClassName="flex-1 min-h-0 overflow-auto p-0"
			footer={truncated ? `Top ${rowLimit} rows` : undefined}
			loadingSkeleton={
				<div className="p-3 flex flex-col gap-2">
					{Array.from({ length: 3 }).map((_, i) => (
						<Skeleton key={i} className="h-6 w-full" />
					))}
				</div>
			}
		>
			<Table>
				<TableHeader>
					<TableRow>
						{effectiveColumns.map((col, colIndex) => {
							const active = sortKey === col.field
							return (
								<TableHead
									key={col.field}
									className={cn("text-xs", columnVisibilityClass(colIndex))}
									aria-sort={
										active ? (sortDir === "asc" ? "ascending" : "descending") : "none"
									}
									style={{
										textAlign: col.align ?? "left",
										width: col.width ? `${col.width}px` : undefined,
									}}
								>
									<button
										type="button"
										onClick={() => handleSort(col.field)}
										className={cn(
											"inline-flex max-w-full items-center gap-1 transition-colors",
											col.align === "right" && "justify-end",
											active
												? "text-foreground"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										<span className="truncate">{col.header}</span>
										<ArrowUpDownIcon
											size={10}
											className={cn(
												"shrink-0 transition-opacity",
												active ? "opacity-100" : "opacity-40",
												active && sortDir === "asc" && "rotate-180",
											)}
										/>
									</button>
								</TableHead>
							)
						})}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.length === 0 ? (
						<TableRow>
							<TableCell
								colSpan={effectiveColumns.length}
								className="text-center text-xs text-muted-foreground"
							>
								No data
							</TableCell>
						</TableRow>
					) : (
						sorted.map((row, i) => (
							<TableRow key={rowKeys[i]}>
								{effectiveColumns.map((col, colIndex) => {
									const value = row[col.field]
									const thresholdColor = getCellThresholdColor(value, col.thresholds)
									return (
										<TableCell
											key={col.field}
											className={cn("text-xs", columnVisibilityClass(colIndex))}
											style={{
												textAlign: col.align ?? "left",
												color: thresholdColor,
												fontWeight: thresholdColor ? 500 : undefined,
											}}
										>
											{formatCellValue(value, col.unit)}
										</TableCell>
									)
								})}
							</TableRow>
						))
					)}
				</TableBody>
			</Table>
		</WidgetFrame>
	)
})
