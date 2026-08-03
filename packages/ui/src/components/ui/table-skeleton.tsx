// Loading placeholder for row tables. Replaces the hand-rolled
// `<Table><Skeleton/></Table>` blocks every list view used to carry — pass the
// real column headers so the table doesn't reflow when data lands.

import type { CSSProperties, ReactNode } from "react"

import { Skeleton } from "./skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table"
import { cn } from "../../lib/utils"

export interface TableSkeletonColumn {
	header?: ReactNode
	/** Classes for the `<TableHead>` — width and responsive-hide classes go here. */
	headClassName?: string
	/** Classes for each body `<TableCell>`; typically the same responsive-hide classes. */
	cellClassName?: string
	/**
	 * Classes for the skeleton bar (e.g. `"w-48"`, `"h-8 w-full"`); `h-4` unless
	 * overridden. Pass `null` to leave the cell empty (expander/icon columns).
	 */
	skeleton?: string | null
	/** Inline width for the `<TableHead>` (e.g. `"12%"` or a px number), for style-driven layouts. */
	width?: string | number
}

export interface TableSkeletonProps {
	/** Column count for anonymous bars, or per-column config mirroring the real table. */
	columns: number | ReadonlyArray<TableSkeletonColumn>
	rows?: number
	showHeader?: boolean
	/** Classes for the `<Table>` itself (e.g. `"table-fixed"`). */
	tableClassName?: string
	/** Classes for the wrapper; defaults to the standard bordered card. */
	className?: string
}

const DEFAULT_SKELETON = "w-24"

export function TableSkeleton({
	columns,
	rows = 8,
	showHeader = true,
	tableClassName,
	className,
}: TableSkeletonProps) {
	const columnList: ReadonlyArray<TableSkeletonColumn> =
		typeof columns === "number" ? Array.from({ length: columns }, () => ({})) : columns

	return (
		<div className={cn("rounded-md border overflow-auto", className)}>
			<Table className={tableClassName}>
				{showHeader && (
					<TableHeader>
						<TableRow>
							{columnList.map((column, i) => (
								<TableHead
									key={i}
									className={column.headClassName}
									style={
										column.width != null
											? ({ width: column.width } satisfies CSSProperties)
											: undefined
									}
								>
									{column.header}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
				)}
				<TableBody>
					{Array.from({ length: rows }).map((_, rowIndex) => (
						<TableRow key={rowIndex}>
							{columnList.map((column, colIndex) => (
								<TableCell key={colIndex} className={column.cellClassName}>
									{column.skeleton !== null && (
										<Skeleton
											className={cn("h-4", column.skeleton ?? DEFAULT_SKELETON)}
										/>
									)}
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	)
}
