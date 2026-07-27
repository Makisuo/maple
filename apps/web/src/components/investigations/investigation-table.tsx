import type { MouseEvent, ReactNode } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeTime, toEpochMs } from "@maple/ui/time-format"

import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "@/components/icons"
import { SeverityBadge } from "@/components/errors/severity-badge"
import { ConfidenceMeter } from "./confidence-meter"
import {
	investigationFinding,
	investigationHeadline,
	investigationScope,
	investigationSeverity,
	type InvestigationSortKey,
	type SortDirection,
} from "./investigation-display"
import { InvestigationKindMarker, InvestigationStatusBadge } from "./investigation-status"

export interface InvestigationSort {
	readonly key: InvestigationSortKey
	readonly direction: SortDirection
}

/**
 * The fixed columns come to 420px, and Subject and Finding need room to say
 * anything at all. `min-width` on a `th` is ignored under `table-layout: fixed`
 * — the floor has to live on the table, so a narrow viewport scrolls the
 * wrapper instead of crushing the two prose columns to nothing.
 */
const TABLE_LAYOUT = "table-fixed min-w-[56rem]"

/**
 * Left to right: what happened → how bad → what Maple concluded → how sure it
 * is → where the run stands → when. Severity and confidence used to sit as two
 * interchangeable word columns; confidence now sits against the finding it
 * qualifies, and kind and origin fold into the subject's marker rather than
 * spending a column each on one repeated word.
 */
export function InvestigationTable({
	investigations,
	sort,
	onSort,
}: {
	investigations: ReadonlyArray<V2Investigation>
	sort: InvestigationSort
	onSort: (key: InvestigationSortKey) => void
}) {
	return (
		<div className="overflow-x-auto">
			<Table className={TABLE_LAYOUT}>
				<TableHeader>
					<TableRow>
						<TableHead className="w-[30%]">Subject</TableHead>
						<SortableHead
							label="Severity"
							sortKey="severity"
							sort={sort}
							onSort={onSort}
							className="w-[100px]"
						/>
						<TableHead>Finding</TableHead>
						<SortableHead
							label="Confidence"
							sortKey="confidence"
							sort={sort}
							onSort={onSort}
							className="w-[116px]"
						/>
						<TableHead className="w-[116px]">Status</TableHead>
						<SortableHead
							label="Updated"
							sortKey="updated"
							sort={sort}
							onSort={onSort}
							align="right"
							className="w-[92px]"
						/>
					</TableRow>
				</TableHeader>
				<TableBody>
					{investigations.map((investigation) => (
						<InvestigationRow key={investigation.id} investigation={investigation} />
					))}
				</TableBody>
			</Table>
		</div>
	)
}

function InvestigationRow({ investigation }: { investigation: V2Investigation }) {
	const navigate = useNavigate()
	const headline = investigationHeadline(investigation)
	const scope = investigationScope(investigation)
	const finding = investigationFinding(investigation)

	// The headline stays a real link so cmd-click and "open in new tab" work;
	// the row handler is the convenience path and must not double-fire on it.
	const openRow = (event: MouseEvent<HTMLTableRowElement>) => {
		if (event.defaultPrevented) return
		if ((event.target as HTMLElement).closest("a")) return
		void navigate({ to: "/investigations/$id", params: { id: investigation.id } })
	}

	return (
		<TableRow className="cursor-pointer" onClick={openRow}>
			<TableCell className="align-top">
				<div className="flex items-start gap-2">
					<InvestigationKindMarker
						subject={investigation.subject}
						seededBy={investigation.seeded_by}
						className="mt-[3px]"
					/>
					<div className="min-w-0 flex-1">
						<Link
							to="/investigations/$id"
							params={{ id: investigation.id }}
							className="block truncate font-medium text-foreground hover:underline"
							title={headline}
						>
							{headline}
						</Link>
						{scope ? (
							<p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{scope}</p>
						) : null}
					</div>
				</div>
			</TableCell>
			<TableCell className="align-top">
				<SeverityBadge severity={investigationSeverity(investigation)} />
			</TableCell>
			<TableCell className="align-top">
				{finding.kind === "none" ? (
					<span className="text-xs text-muted-foreground/60">—</span>
				) : (
					<span className="flex min-w-0 items-center gap-1.5" title={finding.text}>
						{finding.kind === "pending" ? (
							<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
						) : null}
						<span
							className={cn(
								"truncate text-xs",
								finding.kind === "failure"
									? "text-destructive"
									: finding.kind === "pending"
										? "text-muted-foreground"
										: "text-foreground",
							)}
						>
							{finding.text}
						</span>
					</span>
				)}
			</TableCell>
			<TableCell className="align-top">
				<ConfidenceMeter confidence={investigation.confidence} />
			</TableCell>
			<TableCell className="align-top">
				<InvestigationStatusBadge status={investigation.status} />
			</TableCell>
			<TableCell className="text-right align-top text-xs text-muted-foreground">
				<time
					dateTime={investigation.updated_at}
					title={new Date(toEpochMs(investigation.updated_at)).toLocaleString()}
				>
					{formatRelativeTime(investigation.updated_at)}
				</time>
			</TableCell>
		</TableRow>
	)
}

function SortableHead({
	label,
	sortKey,
	sort,
	onSort,
	align = "left",
	className,
}: {
	label: string
	sortKey: InvestigationSortKey
	sort: InvestigationSort
	onSort: (key: InvestigationSortKey) => void
	align?: "left" | "right"
	className?: string
}) {
	const isActive = sort.key === sortKey
	return (
		<TableHead
			className={className}
			aria-sort={isActive ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
		>
			<button
				type="button"
				onClick={() => onSort(sortKey)}
				className={cn(
					"group -mx-1 inline-flex w-[calc(100%+0.5rem)] items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					align === "right" && "justify-end",
					isActive && "text-foreground",
				)}
			>
				{label}
				<SortGlyph active={isActive} direction={sort.direction} />
			</button>
		</TableHead>
	)
}

function SortGlyph({ active, direction }: { active: boolean; direction: SortDirection }): ReactNode {
	if (!active) {
		return (
			<ArrowUpDownIcon
				className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60"
				aria-hidden
			/>
		)
	}
	return direction === "desc" ? (
		<ArrowDownIcon className="size-3 shrink-0" aria-hidden />
	) : (
		<ArrowUpIcon className="size-3 shrink-0" aria-hidden />
	)
}

/** Ghosts the real column widths, so the table doesn't reflow when rows land. */
export function InvestigationTableSkeleton() {
	return (
		<div className="overflow-x-auto" aria-label="Loading investigations">
			<Table className={TABLE_LAYOUT}>
				<TableHeader>
					<TableRow>
						<TableHead className="w-[30%]">Subject</TableHead>
						<TableHead className="w-[100px]">Severity</TableHead>
						<TableHead>Finding</TableHead>
						<TableHead className="w-[116px]">Confidence</TableHead>
						<TableHead className="w-[116px]">Status</TableHead>
						<TableHead className="w-[92px] text-right">Updated</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{Array.from({ length: 5 }, (_, index) => (
						<TableRow key={index}>
							<TableCell>
								<Skeleton className="h-4 w-[70%]" />
							</TableCell>
							<TableCell>
								<Skeleton className="h-4 w-14" />
							</TableCell>
							<TableCell>
								<Skeleton className="h-4 w-[80%]" />
							</TableCell>
							<TableCell>
								<Skeleton className="h-4 w-16" />
							</TableCell>
							<TableCell>
								<Skeleton className="h-4 w-20" />
							</TableCell>
							<TableCell>
								<Skeleton className="ml-auto h-4 w-10" />
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	)
}
