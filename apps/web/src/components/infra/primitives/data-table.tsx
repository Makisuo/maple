// Shared chrome for the infra resource tables (hosts, pods, nodes, workloads).
// Each table keeps its own row JSX — only the sort logic, column header, meta
// chip, container, and skeleton shell live here.

import * as React from "react"
import { cn } from "@maple/ui/lib/utils"

import { ArrowUpDownIcon } from "@/components/icons"

// `useTableSort` moved to @/hooks/use-table-sort when the dashboard table widget
// started sharing it. Re-exported here so the infra tables keep one import.
export { useTableSort } from "@/hooks/use-table-sort"
export type { SortDir } from "@/hooks/use-table-sort"

import type { SortDir } from "@/hooks/use-table-sort"

/** Row-link className shared by every table row (kept here so the styling is one source). */
export const ROW_LINK_CLASS =
	"group flex items-center gap-4 border-b border-border/40 px-4 py-3 transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"

/**
 * Row className for tables whose rows *select* rather than navigate. Same chrome as
 * `ROW_LINK_CLASS` plus button resets; pair it with `aria-pressed` so the selected
 * row is announced, not just tinted.
 */
export const ROW_BUTTON_CLASS =
	"group flex w-full items-center gap-4 border-b border-border/40 px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none aria-pressed:bg-muted/40"

/**
 * The three sort props a `ColumnHead` needs, as one spreadable object. Lets a
 * table declare its column list once and render it twice — interactive for the
 * table, inert for the skeleton — instead of duplicating the columns per state.
 */
export interface SortControls<K extends string> {
	currentKey: K | null
	dir: SortDir
	onSort: (k: K) => void
}

interface ColumnHeadProps<K extends string> {
	label: string
	width: string
	sortKey?: K
	currentKey?: K | null
	dir?: SortDir
	onSort?: (k: K) => void
	align?: "left" | "right"
	hidden?: string
}

export function ColumnHead<K extends string>({
	label,
	width,
	sortKey,
	currentKey,
	dir,
	onSort,
	align = "left",
	hidden,
}: ColumnHeadProps<K>) {
	const active = sortKey !== undefined && currentKey === sortKey
	return (
		<div
			className={cn(
				"flex items-center text-[11px] font-medium",
				align === "right" && "justify-end",
				width,
				hidden,
			)}
		>
			{sortKey !== undefined ? (
				<button
					type="button"
					onClick={() => onSort?.(sortKey)}
					className={cn(
						"inline-flex items-center gap-1 transition-colors",
						active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
					)}
				>
					{label}
					<ArrowUpDownIcon
						size={10}
						className={cn(
							"transition-opacity",
							active ? "opacity-100" : "opacity-40",
							active && dir === "asc" && "rotate-180",
						)}
					/>
				</button>
			) : (
				<span className="text-muted-foreground">{label}</span>
			)}
		</div>
	)
}

export function MetaChip({ children }: { children: React.ReactNode }) {
	return <span className="font-mono text-[10px] text-muted-foreground/80">{children}</span>
}

/* -------------------------------------------------------------------------------------------------
 * DataTable — compound chrome for the infra resource tables
 *
 * Replaces `TableShell` + `TableSkeleton`, which between them used three slot
 * idioms: a `header` ReactNode prop, `children` for rows, and a `renderRowCells`
 * render prop whose index argument all eight call sites ignored. Everything is
 * children now, and `isEmpty` + `emptyMessage` (a boolean/string pair threaded
 * through thirteen files) collapses into `<DataTable.Empty>`.
 *
 * The point of `Head` being a real component: a table can now declare its column
 * list once and hand it to both the table and its skeleton. Previously each file
 * wrote the columns twice with hand-matched `width` strings, so a mismatch
 * silently misaligned the loading state.
 * -----------------------------------------------------------------------------------------------*/

interface DataTableContextValue {
	scrolls: boolean
	stickySurfaceClass: string
}

const DataTableContext = React.createContext<DataTableContextValue | null>(null)

function useDataTable() {
	const ctx = React.use(DataTableContext)
	if (!ctx) throw new Error("DataTable.* components must be used within <DataTable.Root>")
	return ctx
}

interface DataTableRootProps {
	ariaLabel: string
	waiting?: boolean
	/**
	 * Cap the row area at this pixel height and scroll inside it, with the column heads pinned.
	 * For lists whose length is the server's limit rather than a human number — 100 breakdown keys,
	 * 500 zones — this keeps the table a fixed-size instrument instead of a page that grows past
	 * everything below it. Omit for tables that are short by nature.
	 */
	maxHeight?: number
	/** Surface the pinned header sits on. Defaults to the page background; pass `bg-card` inside a card. */
	stickySurfaceClass?: string
	children: React.ReactNode
}

function DataTableRoot({
	ariaLabel,
	waiting,
	maxHeight,
	stickySurfaceClass = "bg-background",
	children,
}: DataTableRootProps) {
	const scrolls = maxHeight !== undefined
	const ctx = React.useMemo(() => ({ scrolls, stickySurfaceClass }), [scrolls, stickySurfaceClass])

	return (
		<DataTableContext value={ctx}>
			<div
				className={cn("border-y border-border/70 transition-opacity", waiting && "opacity-60")}
				aria-label={ariaLabel}
			>
				<div
					className={cn(scrolls && "overflow-y-auto overscroll-contain")}
					style={scrolls ? { maxHeight } : undefined}
				>
					{children}
				</div>
			</div>
		</DataTableContext>
	)
}

/** The `<ColumnHead>` row. Pins itself when the root scrolls. */
function DataTableHead({ children }: { children: React.ReactNode }) {
	const { scrolls, stickySurfaceClass } = useDataTable()
	return (
		<div
			className={cn(
				"flex items-center gap-4 border-b border-border/60 px-4 py-2",
				scrolls && `sticky top-0 z-10 ${stickySurfaceClass}`,
			)}
		>
			{children}
		</div>
	)
}

/** Rendered in place of the rows when there are none. */
function DataTableEmpty({ children }: { children: React.ReactNode }) {
	return <div className="px-4 py-12 text-center text-[12px] text-muted-foreground">{children}</div>
}

/**
 * `count` identical placeholder rows. `children` are the cells of one row —
 * repeated as-is, since no caller ever varied a placeholder row by index.
 */
function DataTableSkeletonRows({ count, children }: { count: number; children: React.ReactNode }) {
	return (
		<>
			{Array.from({ length: count }).map((_, i) => (
				<div
					key={i}
					className="flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0"
				>
					{children}
				</div>
			))}
		</>
	)
}

export const DataTable = {
	Root: DataTableRoot,
	Head: DataTableHead,
	Empty: DataTableEmpty,
	SkeletonRows: DataTableSkeletonRows,
}
