"use client"

import { createContext, use, type ReactNode } from "react"

import { cn } from "../../../lib/utils"
import { ChartSkeleton, type ChartSkeletonVariant } from "./chart-skeleton"

/**
 * The non-plotted states of a chart — loading, empty, error — as one system.
 *
 * ## Why this exists
 *
 * Every async chart renders the same three branches, and before this each one
 * spelled them out by hand. The result was drift in every dimension that is
 * supposed to be a constant: `rounded-none` vs `rounded-md` vs `rounded-lg` on
 * the skeleton, `font-mono text-[11px]` vs `text-xs` on the message, a
 * `border-destructive/40 bg-destructive/5` error box copied verbatim across four
 * files. None of that is a per-chart decision, so none of it belongs at a call
 * site.
 *
 * ## The height is the load-bearing part
 *
 * A chart's plot height was repeated as a magic number in each branch — the
 * skeleton's `h-[280px]`, the error box's `h-[280px]`, and the plot's own
 * `height={CHART_HEIGHT}` — three copies that had to be edited together and
 * silently disagreed when they weren't. {@link ChartPlotArea} declares it ONCE
 * and the states read it from context, so a branch can no longer reserve a
 * different box than the chart it stands in for. That is what keeps the swap-in
 * from jumping.
 *
 * Deliberately NOT unified to a single global height: infra detail (200), host
 * (220) and k8s (280) plot at genuinely different sizes. This makes the number a
 * per-chart declaration instead of a per-branch literal — it does not flatten
 * the sizes themselves.
 */

const ChartPlotHeightContext = createContext<number | null>(null)

/**
 * Reserves a chart's plot box and publishes its height to the state components
 * inside it.
 *
 * Wrap the whole async branch, not just one arm:
 *
 * ```tsx
 * <ChartPlotArea height={CHART_HEIGHT}>
 *   {Result.builder(result)
 *     .onInitial(() => <ChartLoading variant="area" />)
 *     .onError((err) => <ChartError>{displayError(err).message}</ChartError>)
 *     .onSuccess((data) => <MyChart rows={data} />)
 *     .render()}
 * </ChartPlotArea>
 * ```
 */
export function ChartPlotArea({
	height,
	children,
	className,
}: {
	height: number
	children: ReactNode
	className?: string
}) {
	return (
		<ChartPlotHeightContext value={height}>
			<div className={cn("w-full", className)} style={{ height }} data-slot="chart-plot-area">
				{children}
			</div>
		</ChartPlotHeightContext>
	)
}

/**
 * The plot height published by the nearest {@link ChartPlotArea}, or `null`
 * outside one.
 *
 * A chart that sizes its own inner plot should prefer this over a local
 * constant, so the plot and the branches it alternates with cannot disagree.
 */
export function useChartPlotHeight(): number | null {
	return use(ChartPlotHeightContext)
}

/**
 * Fills the plot box. Inside a {@link ChartPlotArea} that is simply `h-full`;
 * standalone it falls back to the explicit `height` so a state can still be
 * dropped somewhere without a provider.
 */
function ChartStateBox({
	height,
	className,
	children,
}: {
	height?: number
	className?: string
	children: ReactNode
}) {
	const inherited = useChartPlotHeight()
	// An explicit prop wins; inside a provider with no override the box simply
	// fills what the provider already reserved (so a legend or footer sibling
	// shrinking it stays honoured); with neither, the parent owns the height.
	const sizing =
		height != null ? { height } : inherited != null ? { height: "100%" as const } : undefined

	return (
		<div className={cn("w-full", sizing == null && "h-full", className)} style={sizing}>
			{children}
		</div>
	)
}

/**
 * A chart still loading. Draws the ghost shape matching what will replace it, so
 * the swap-in changes content rather than layout.
 *
 * `variant` is the registry's chart category — pass the one the success branch
 * actually renders.
 */
export function ChartLoading({
	variant,
	height,
	className,
}: {
	variant: ChartSkeletonVariant
	height?: number
	className?: string
}) {
	return (
		<ChartStateBox height={height} className={className}>
			<ChartSkeleton variant={variant} />
		</ChartStateBox>
	)
}

/** Shared type + layout of the two message states, so they cannot drift apart. */
const MESSAGE_BASE = "flex items-center justify-center px-3 text-center font-mono text-[11px]"

/**
 * A chart with nothing to draw — "no data in this window", "not collected yet".
 *
 * Distinct from {@link ChartError} on purpose rather than a `tone` prop: empty
 * is an ordinary outcome and reads as muted chrome, while an error is a failure
 * and reads as destructive. Collapsing them into one component with a flag is
 * how the two end up looking alike.
 *
 * Borderless, following `ChartCardMessage` and the Cloudflare/PlanetScale/
 * analytics charts. `InfraMetricChart` was the lone site drawing a dashed
 * border here; an empty window is a normal outcome inside a card that already
 * has a frame, so a second frame around the message just adds noise.
 */
export function ChartEmpty({ children, height, className }: {
	children: ReactNode
	height?: number
	className?: string
}) {
	return (
		<ChartStateBox
			height={height}
			className={cn(MESSAGE_BASE, "text-muted-foreground", className)}
		>
			{children}
		</ChartStateBox>
	)
}

/** A chart whose query failed. */
export function ChartError({ children, height, className }: {
	children: ReactNode
	height?: number
	className?: string
}) {
	return (
		<ChartStateBox
			height={height}
			className={cn(MESSAGE_BASE, "border border-destructive/40 bg-destructive/5 text-destructive", className)}
		>
			{children}
		</ChartStateBox>
	)
}
