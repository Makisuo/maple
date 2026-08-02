import type { CSSProperties, ReactNode } from "react"

import { ChartSkeleton, type ChartSkeletonVariant } from "@maple/ui/components/charts"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

/**
 * Structural loading states for the dashboard routes. Each skeleton mirrors the
 * real layout it stands in for so content swaps in without a jump; tiles fade
 * in with a small stagger (disabled under reduced motion).
 */

function tileDelay(index: number): CSSProperties {
	return { animationDelay: `${index * 40}ms` }
}

function StatusRegion({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div role="status" aria-label={label}>
			<span className="sr-only">{label}</span>
			{children}
		</div>
	)
}

function GhostWidgetCard({
	variant,
	index,
	className,
}: {
	variant: ChartSkeletonVariant
	index: number
	className?: string
}) {
	return (
		<div
			className={`flex flex-col overflow-hidden rounded-md ring-1 ring-border bg-card animate-tile-in motion-reduce:animate-none ${className ?? ""}`}
			style={tileDelay(index)}
		>
			<div className="flex items-center px-3 pt-3 pb-2">
				<Skeleton className="h-3 w-24" />
			</div>
			<div className="min-h-0 flex-1 p-2 pt-0">
				<ChartSkeleton variant={variant} />
			</div>
		</div>
	)
}

/** Ghost widget grid for `/dashboards/$dashboardId` while the store hydrates. */
export function DashboardViewSkeleton() {
	return (
		<StatusRegion label="Loading dashboard">
			<div className="flex flex-col gap-4" aria-hidden>
				<div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
					{[0, 1, 2, 3].map((i) => (
						<GhostWidgetCard key={i} variant="stat" index={i} className="h-28" />
					))}
				</div>
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
					<GhostWidgetCard variant="line" index={4} className="h-64" />
					<GhostWidgetCard variant="bar" index={5} className="h-64" />
				</div>
				<GhostWidgetCard variant="area" index={6} className="h-64" />
			</div>
		</StatusRegion>
	)
}

/**
 * Per-row widths for the list ghost. Varying them keeps the placeholder from
 * reading as a table of identical bars, and the pairs match the row's real
 * name / description rhythm.
 */
const GHOST_ROWS = [
	{ name: "w-44", description: "w-80", reads: "w-24" },
	{ name: "w-32", description: "w-64", reads: "w-16" },
	{ name: "w-52", description: "w-96", reads: "w-28" },
	{ name: "w-36", description: "w-72", reads: "w-20" },
	{ name: "w-40", description: "w-56", reads: "w-24" },
	{ name: "w-28", description: "w-88", reads: "w-16" },
] as const

/** One ghost row on the same lane grid as `DashboardRow`, so nothing shifts. */
function GhostDashboardRow({ index }: { index: number }) {
	const row = GHOST_ROWS[index % GHOST_ROWS.length]
	return (
		<div
			className="flex h-13 items-center border-b border-border last:border-b-0 animate-tile-in motion-reduce:animate-none"
			style={tileDelay(index)}
		>
			<span className="w-0.5 shrink-0" />
			<Skeleton className="ml-3 size-5.5 shrink-0 rounded-sm" />
			<div className="flex min-w-0 grow flex-col gap-1.5 px-3">
				<Skeleton className={`h-3 ${row.name}`} />
				<Skeleton className={`h-2.5 ${row.description} opacity-60`} />
			</div>
			<div className="hidden w-40 shrink-0 flex-col items-end gap-1.5 sm:flex">
				<Skeleton className="h-2.5 w-16" />
				<Skeleton className={`h-2.5 ${row.reads} opacity-60`} />
			</div>
			<div className="flex w-24 shrink-0 justify-end">
				<Skeleton className="h-2.5 w-12 opacity-60" />
			</div>
			<div className="flex shrink-0 items-center gap-1.5 pr-2 pl-3">
				<Skeleton className="size-3.5 shrink-0 rounded-sm opacity-50" />
				<Skeleton className="size-3.5 shrink-0 rounded-sm opacity-50" />
			</div>
		</div>
	)
}

/** Toolbar + row-list ghost for the `/dashboards` list. */
export function DashboardListSkeleton() {
	return (
		<StatusRegion label="Loading dashboards">
			<div aria-hidden>
				<div className="flex flex-wrap items-center gap-2 pb-3">
					<Skeleton className="h-8 grow sm:max-w-70" />
					<Skeleton className="h-8 w-32 shrink-0" />
					<Skeleton className="h-8 w-16 shrink-0" />
					<Skeleton className="h-8 w-36 shrink-0" />
				</div>
				<div className="flex items-center gap-2 pb-2">
					<Skeleton className="h-2.5 w-24" />
				</div>
				{[0, 1, 2, 3, 4, 5].map((i) => (
					<GhostDashboardRow key={i} index={i} />
				))}
			</div>
		</StatusRegion>
	)
}

/** Preview pane + form-field ghost for the widget configure route. */
export function WidgetEditorSkeleton() {
	return (
		<StatusRegion label="Loading widget">
			<div className="flex flex-col gap-6" aria-hidden>
				<div
					className="h-64 w-full overflow-hidden rounded-md ring-1 ring-border bg-card p-2 animate-tile-in motion-reduce:animate-none"
					style={tileDelay(0)}
				>
					<ChartSkeleton variant="line" />
				</div>
				<div className="flex max-w-md flex-col gap-4">
					{[1, 2, 3, 4].map((i) => (
						<div
							key={i}
							className="flex flex-col gap-1.5 animate-tile-in motion-reduce:animate-none"
							style={tileDelay(i)}
						>
							<Skeleton className="h-3 w-20" />
							<Skeleton className="h-9 w-full" />
						</div>
					))}
				</div>
			</div>
		</StatusRegion>
	)
}
