// Shared chrome for the infra resource tables (hosts, pods, nodes, workloads).
// Each table keeps its own row JSX — only the sort logic, column header, meta
// chip, container, and skeleton shell live here.

import { useMemo, useState } from "react"
import { cn } from "@maple/ui/lib/utils"

import { ArrowUpDownIcon } from "@/components/icons"

export type SortDir = "asc" | "desc"

/** Row-link className shared by every table row (kept here so the styling is one source). */
export const ROW_LINK_CLASS =
	"group flex items-center gap-4 border-b border-border/40 px-4 py-3 transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"

interface UseTableSortOptions<K> {
	initialKey: K
	initialDir?: SortDir
	/** Keys that should default to ascending on first click (names, namespaces, …). */
	stringKeys?: ReadonlyArray<K>
}

export function useTableSort<Row, K extends keyof Row>(
	rows: ReadonlyArray<Row>,
	{ initialKey, initialDir = "desc", stringKeys }: UseTableSortOptions<K>,
) {
	const [sortKey, setSortKey] = useState<K>(initialKey)
	const [sortDir, setSortDir] = useState<SortDir>(initialDir)

	const handleSort = (k: K) => {
		if (k === sortKey) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"))
		} else {
			setSortKey(k)
			setSortDir(stringKeys?.includes(k) ? "asc" : "desc")
		}
	}

	const sorted = useMemo(() => {
		const copy = [...rows]
		copy.sort((a, b) => {
			const av = a[sortKey]
			const bv = b[sortKey]
			if (typeof av === "number" && typeof bv === "number") {
				return sortDir === "asc" ? av - bv : bv - av
			}
			const as = String(av)
			const bs = String(bv)
			return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as)
		})
		return copy
	}, [rows, sortKey, sortDir])

	return { sorted, sortKey, sortDir, handleSort }
}

interface ColumnHeadProps<K extends string> {
	label: string
	width: string
	sortKey?: K
	currentKey?: K
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

interface TableShellProps {
	ariaLabel: string
	waiting?: boolean
	/** The <ColumnHead> row. */
	header: React.ReactNode
	isEmpty: boolean
	emptyMessage: string
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

export function TableShell({
	ariaLabel,
	waiting,
	header,
	isEmpty,
	emptyMessage,
	maxHeight,
	stickySurfaceClass = "bg-background",
	children,
}: TableShellProps) {
	const scrolls = maxHeight !== undefined
	return (
		<div
			className={cn("border-y border-border/70 transition-opacity", waiting && "opacity-60")}
			aria-label={ariaLabel}
		>
			<div
				className={cn(scrolls && "overflow-y-auto overscroll-contain")}
				style={scrolls ? { maxHeight } : undefined}
			>
				<div
					className={cn(
						"flex items-center gap-4 border-b border-border/60 px-4 py-2",
						scrolls && `sticky top-0 z-10 ${stickySurfaceClass}`,
					)}
				>
					{header}
				</div>
				{isEmpty ? (
					<div className="px-4 py-12 text-center text-[12px] text-muted-foreground">
						{emptyMessage}
					</div>
				) : (
					children
				)}
			</div>
		</div>
	)
}

interface TableSkeletonProps {
	/** The <ColumnHead> row (no sort handlers). */
	header: React.ReactNode
	rows: number
	renderRowCells: (index: number) => React.ReactNode
}

export function TableSkeleton({ header, rows, renderRowCells }: TableSkeletonProps) {
	return (
		<div className="border-y border-border/70">
			<div className="flex items-center gap-4 border-b border-border/60 px-4 py-2">{header}</div>
			{Array.from({ length: rows }).map((_, i) => (
				<div
					key={i}
					className="flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0"
				>
					{renderRowCells(i)}
				</div>
			))}
		</div>
	)
}
