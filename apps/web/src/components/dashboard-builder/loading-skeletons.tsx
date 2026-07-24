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
 * Mini ghost mosaics for the list-card preview strip — varied per card so the
 * grid doesn't look stamped from one mold. Percent-based rects mirror
 * `DashboardPreview`'s absolute tile layout.
 */
const PREVIEW_MOSAICS: ReadonlyArray<
	ReadonlyArray<{ left: string; top: string; width: string; height: string }>
> = [
	[
		{ left: "0%", top: "0%", width: "48%", height: "46%" },
		{ left: "52%", top: "0%", width: "48%", height: "46%" },
		{ left: "0%", top: "54%", width: "100%", height: "46%" },
	],
	[
		{ left: "0%", top: "0%", width: "31%", height: "46%" },
		{ left: "35%", top: "0%", width: "31%", height: "46%" },
		{ left: "70%", top: "0%", width: "30%", height: "46%" },
		{ left: "0%", top: "54%", width: "66%", height: "46%" },
		{ left: "70%", top: "54%", width: "30%", height: "46%" },
	],
	[
		{ left: "0%", top: "0%", width: "100%", height: "46%" },
		{ left: "0%", top: "54%", width: "48%", height: "46%" },
		{ left: "52%", top: "54%", width: "48%", height: "46%" },
	],
	[
		{ left: "0%", top: "0%", width: "66%", height: "100%" },
		{ left: "70%", top: "0%", width: "30%", height: "46%" },
		{ left: "70%", top: "54%", width: "30%", height: "46%" },
	],
]

const LIST_TITLE_WIDTHS = ["w-32", "w-24", "w-40", "w-28", "w-36", "w-24"] as const

function GhostDashboardCard({ index }: { index: number }) {
	const mosaic = PREVIEW_MOSAICS[index % PREVIEW_MOSAICS.length]
	return (
		<div
			className="flex flex-col overflow-hidden rounded-md ring-1 ring-border bg-card animate-tile-in motion-reduce:animate-none"
			style={tileDelay(index)}
		>
			<div className="h-[100px] w-full border-b border-border bg-background p-3">
				<div className="relative h-full w-full">
					{mosaic.map((rect, i) => (
						<div
							key={i}
							className="absolute rounded-sm bg-muted animate-pulse motion-reduce:animate-none"
							style={{ ...rect, animationDelay: `${-(index + i) * 0.15}s` }}
						/>
					))}
				</div>
			</div>
			<div className="flex flex-col gap-2 p-4">
				<Skeleton className={`h-4 ${LIST_TITLE_WIDTHS[index % LIST_TITLE_WIDTHS.length]}`} />
				<Skeleton className="h-3 w-36" />
			</div>
		</div>
	)
}

/** Toolbar + card-grid ghost for the `/dashboards` list. */
export function DashboardListSkeleton() {
	return (
		<StatusRegion label="Loading dashboards">
			<div aria-hidden>
				<div className="mb-4 flex items-center gap-2">
					<Skeleton className="h-8 w-40" />
					<Skeleton className="h-8 w-24" />
				</div>
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{[0, 1, 2, 3, 4, 5].map((i) => (
						<GhostDashboardCard key={i} index={i} />
					))}
				</div>
			</div>
		</StatusRegion>
	)
}

function GhostTemplateCard({ index }: { index: number }) {
	return (
		<div
			className="flex flex-col overflow-hidden rounded-md ring-1 ring-border bg-card animate-tile-in motion-reduce:animate-none"
			style={tileDelay(index)}
		>
			<div className="h-28 w-full border-b border-border bg-sidebar/60" />
			<div className="flex flex-col gap-2 p-4">
				<div className="flex items-center gap-2">
					<Skeleton className="size-4 rounded-full" />
					<Skeleton className={`h-4 ${LIST_TITLE_WIDTHS[index % LIST_TITLE_WIDTHS.length]}`} />
				</div>
				<Skeleton className="h-3 w-full" />
				<Skeleton className="h-3 w-3/4" />
			</div>
		</div>
	)
}

/** Sectioned card-grid ghost for `/dashboards/templates`. */
export function TemplateGridSkeleton() {
	return (
		<StatusRegion label="Loading templates">
			<div className="flex flex-col gap-8" aria-hidden>
				{[0, 1].map((section) => (
					<section key={section} className="flex flex-col gap-3">
						<Skeleton className="h-3 w-20" />
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
							{[0, 1, 2].map((i) => (
								<GhostTemplateCard key={i} index={section * 3 + i} />
							))}
						</div>
					</section>
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
